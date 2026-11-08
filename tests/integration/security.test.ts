import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config';
import { setRoomStatus } from '../../src/server/db/repos/rooms';
import { buildLoggerOptions, redactLogPath } from '../../src/server/lib/logger';
import {
  CONTENT_SECURITY_POLICY,
  rateLimitCategory,
  securityHeadersFor,
  STRICT_TRANSPORT_SECURITY,
} from '../../src/server/lib/security';
import { makeTestApp, setupHost, type TestApp } from '../helpers/test-app';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const contexts: TestApp[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close();
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

async function boot(): Promise<TestApp> {
  const context = await makeTestApp();
  contexts.push(context);
  return context;
}

function directive(csp: string, name: string): string | undefined {
  return csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
}

function join(context: TestApp, roomCode: string, nickname: string) {
  return context.app.inject({
    method: 'POST',
    url: '/api/guests/join',
    payload: { room_code: roomCode, nickname },
    headers: { 'content-type': 'application/json' },
  });
}

describe('security headers', () => {
  it('sends CSP and policy headers on SSR and API responses, without HSTS over http', async () => {
    const context = await boot();

    for (const url of ['/join', '/api/health']) {
      const response = await context.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);

      const csp = String(response.headers['content-security-policy'] ?? '');
      expect(csp).toContain("default-src 'self'");
      // `wasm-unsafe-eval` is required by the self-hosted Draco decoder; it
      // does not enable general eval.
      expect(directive(csp, 'script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
      expect(directive(csp, 'script-src')).not.toContain("'unsafe-eval'");
      expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
      expect(directive(csp, 'img-src')).toBe("img-src 'self' data: blob:");
      expect(directive(csp, 'media-src')).toBe("media-src 'self'");
      expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
      expect(directive(csp, 'worker-src')).toBe("worker-src 'self' blob:");
      expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
      expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
      expect(directive(csp, 'form-action')).toBe("form-action 'self'");
      expect(directive(csp, 'object-src')).toBe("object-src 'none'");

      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['permissions-policy']).toBe(
        'camera=(), microphone=(), geolocation=()',
      );
      expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');

      // The LAN deployment is plain http: HSTS must stay off.
      expect(response.headers['strict-transport-security']).toBeUndefined();
      // ...but an https request would send it.
      expect(securityHeadersFor(true)['strict-transport-security']).toBe(
        STRICT_TRANSPORT_SECURITY,
      );
      expect(securityHeadersFor(false)['strict-transport-security']).toBeUndefined();
      // Traceable request id for the error envelope / field debugging.
      expect(String(response.headers['x-request-id'] ?? '')).not.toBe('');
    }
  });

  it('echoes a caller-supplied request id so errors stay traceable', async () => {
    const context = await boot();
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'security-test-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('security-test-1');
  });

  it('sends the same headers on hijacked SSE responses', async () => {
    const context = await boot();
    const host = await setupHost(context.app);
    const address = await context.app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();

    try {
      const response = await fetch(
        `${address.replace(/\/$/, '')}/api/board/${host.room.room_id}/stream`,
        { headers: { cookie: host.cookie }, signal: controller.signal },
      );
      expect(response.status).toBe(200);
      expect(String(response.headers.get('content-type'))).toContain('text/event-stream');

      const csp = String(response.headers.get('content-security-policy') ?? '');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'self'");
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(String(response.headers.get('x-request-id') ?? '')).not.toBe('');

      await response.body?.cancel().catch(() => undefined);
    } finally {
      controller.abort();
    }
  });
});

describe('CORS allowlist', () => {
  it('echoes only allowlisted origins and answers their preflight', async () => {
    const context = await boot();
    context.config.server.corsAllowlist = ['http://localhost:5173'];

    const allowed = await context.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(String(allowed.headers.vary ?? '')).toContain('origin');

    const denied = await context.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://evil.example' },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await context.app.inject({
      method: 'OPTIONS',
      url: '/api/guests/join',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-wtm-csrf',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    expect(String(preflight.headers['access-control-allow-methods'])).toContain('POST');
    expect(String(preflight.headers['access-control-allow-headers'])).toContain('x-wtm-csrf');
    expect(String(preflight.headers['access-control-allow-headers'])).toContain('authorization');

    const blockedPreflight = await context.app.inject({
      method: 'OPTIONS',
      url: '/api/guests/join',
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(blockedPreflight.statusCode).not.toBe(204);
    expect(blockedPreflight.headers['access-control-allow-origin']).toBeUndefined();

    const nonApiPreflight = await context.app.inject({
      method: 'OPTIONS',
      url: '/join',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(nonApiPreflight.statusCode).not.toBe(204);
  });
});

describe('rate limiting', () => {
  it('only maps the three public guest entry points', () => {
    expect(rateLimitCategory('POST', '/api/guests/join')).toBe('join');
    expect(rateLimitCategory('POST', '/api/play/shortcode')).toBe('shortcode');
    expect(rateLimitCategory('GET', '/api/play/d/K7mQ2vR9dL')).toBe('card');

    expect(rateLimitCategory('GET', '/api/health')).toBeUndefined();
    expect(rateLimitCategory('GET', '/api/board/room_1/stream')).toBeUndefined();
    expect(rateLimitCategory('POST', '/api/host/login')).toBeUndefined();
    expect(rateLimitCategory('GET', '/assets/app.js')).toBeUndefined();
    expect(rateLimitCategory('GET', '/d/K7mQ2vR9dL')).toBeUndefined();
  });

  it('returns 429 + retry-after after too many joins, leaving other routes alone', async () => {
    const context = await boot();
    const host = await setupHost(context.app);
    setRoomStatus(context.db, host.room.room_id, 'live');

    const limit = context.config.server.rateLimit.joinPerMin;
    expect(limit).toBeGreaterThan(0);

    for (let index = 0; index < limit; index += 1) {
      const response = await join(context, host.room.room_code, `客人${index}`);
      expect(response.statusCode).toBe(200);
    }

    const blocked = await join(context, host.room.room_code, '再来一次');
    expect(blocked.statusCode).toBe(429);

    const body = blocked.json<{
      error: { code: string; message: string; retryable?: boolean; requestId?: string };
    }>();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toMatch(/频繁/);
    expect(body.error.requestId).toBeTruthy();

    const retryAfter = Number(blocked.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);

    // /api/health must not be affected by the guest-entry budget.
    for (let index = 0; index < 3; index += 1) {
      const health = await context.app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
    }

    // The other rate-limited entries keep their own, independent budget.
    const shortcode = await context.app.inject({
      method: 'POST',
      url: '/api/play/shortcode',
      payload: { room_code: '000000', short_code: 'ABC234' },
      headers: { 'content-type': 'application/json' },
    });
    expect(shortcode.statusCode).toBe(404);

    // The 429 response still carries the baseline headers.
    expect(String(blocked.headers['content-security-policy'] ?? '')).toBe(
      CONTENT_SECURITY_POLICY,
    );
  });
});

describe('log redaction', () => {
  it('strips query strings and card tokens from logged paths', () => {
    const token = 'K7mQ2vR9dL';
    expect(redactLogPath(`/d/${token}`)).toBe('/d/[redacted]');
    expect(redactLogPath(`/d/${token}?preview=1`)).toBe('/d/[redacted]');
    expect(redactLogPath(`/api/play/d/${token}`)).toBe('/api/play/d/[redacted]');
    expect(redactLogPath(`/d/${token}/collect`)).toBe('/d/[redacted]/collect');
    expect(redactLogPath('/api/assets/d_001/base-model?t=TICKET123')).toBe(
      '/api/assets/d_001/base-model',
    );

    const config = loadConfig({ rootDir: repoRoot, env: {} });
    const options = buildLoggerOptions(config, { pretty: false }) as unknown as {
      serializers: {
        req: (req: { id?: string; method?: string; url?: string; ip?: string }) => {
          id?: string;
          method?: string;
          path?: string;
          ip?: string;
        };
      };
    };
    const serialized = options.serializers.req({
      id: 'req-1',
      method: 'GET',
      url: `/d/${token}?t=TICKET123`,
      ip: '127.0.0.1',
    });
    expect(serialized.id).toBe('req-1');
    expect(serialized.path).toBe('/d/[redacted]');
    expect(JSON.stringify(serialized)).not.toContain(token);
    expect(JSON.stringify(serialized)).not.toContain('TICKET123');
  });
});

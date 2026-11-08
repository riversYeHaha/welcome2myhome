import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import { AppError } from './errors';
import { SlidingWindowLimiter } from './rate-limit';

/**
 * Security baseline (FR-47): response headers, CORS allowlist and per-IP
 * rate limiting for the public entry points.
 *
 * Headers are written to both the Fastify reply and `reply.raw` during
 * `onRequest`. The raw write is what covers `reply.hijack()` handlers (the
 * board SSE stream): Node merges headers set with `setHeader()` into the later
 * `writeHead()` call, so SSE responses get the same CSP/policy headers without
 * touching the route handlers.
 */

const MINUTE_MS = 60_000;

/**
 * CSP for all documents. Inline `<style>` is allowed because the SSR shell and
 * React views ship critical CSS inline; scripts are external module files only
 * (`<script type="module" src>`), so no `'unsafe-inline'` for scripts.
 *
 * `worker-src 'self' blob:` is required by the three.js DRACO decoder worker;
 * `img-src data: blob:` covers inline SVG/data URLs and generated thumbnails.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // `wasm-unsafe-eval` is narrowed to WebAssembly compilation only: the
  // self-hosted Draco decoder compiles its WASM module inside a blob worker.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()';

/** Sent over https only: local LAN deployments are plain http on purpose. */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

/** Header payload for one request; `secure` gates HSTS. */
export function securityHeadersFor(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': PERMISSIONS_POLICY,
    'cross-origin-opener-policy': 'same-origin',
  };
  if (secure) headers['strict-transport-security'] = STRICT_TRANSPORT_SECURITY;
  return headers;
}

/** Request path without query/hash; never log the raw URL. */
export function pathnameOf(url: string): string {
  const pathname = (url.split('?')[0] ?? '').split('#')[0] ?? '';
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

/**
 * `request.id` comes from the `x-request-id` header when supplied, so keep the
 * response header to a safe header-value alphabet and a bounded length.
 */
export function requestIdHeaderValue(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);
  return safe.length > 0 ? safe : 'request';
}

function normalizeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** Exact (normalized) origin match against `config.server.corsAllowlist`. */
export function isAllowedOrigin(config: AppConfig, origin: string): boolean {
  const target = normalizeOrigin(origin);
  if (!target) return false;
  return config.server.corsAllowlist.some((entry) => normalizeOrigin(entry) === target);
}

function setHeader(reply: FastifyReply, name: string, value: string): void {
  reply.header(name, value);
  // `reply.raw` keeps the header available to hijacked/SSE responses too.
  if (!reply.raw.headersSent) reply.raw.setHeader(name, value);
}

function appendVary(reply: FastifyReply, value: string): void {
  const current = reply.getHeader('vary');
  const values = new Set(
    String(current ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0),
  );
  values.add(value.toLowerCase());
  setHeader(reply, 'vary', [...values].join(', '));
}

function applySecurityHeaders(request: FastifyRequest, reply: FastifyReply): void {
  const headers = securityHeadersFor(request.protocol === 'https');
  headers['x-request-id'] = requestIdHeaderValue(String(request.id ?? ''));
  for (const [name, value] of Object.entries(headers)) {
    setHeader(reply, name, value);
  }
}

function applyCorsHeaders(request: FastifyRequest, reply: FastifyReply, config: AppConfig): void {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return;

  // Responses depend on Origin, so caches must split on it regardless of
  // whether the origin is allowed.
  appendVary(reply, 'origin');

  if (!isAllowedOrigin(config, origin)) return;
  // Exact echo, never `*`: credentials are allowed for the dev proxy/client.
  setHeader(reply, 'access-control-allow-origin', origin);
  setHeader(reply, 'access-control-allow-credentials', 'true');
}

type RateLimitCategory = 'join' | 'shortcode' | 'card';

/** Only the three public entry points are IP-limited; health/static/SSE/host are not. */
export function rateLimitCategory(method: string, pathname: string): RateLimitCategory | undefined {
  if (method === 'POST' && pathname === '/api/guests/join') return 'join';
  if (method === 'POST' && pathname === '/api/play/shortcode') return 'shortcode';
  if (
    method === 'GET' &&
    (pathname === '/api/play/d' || pathname.startsWith('/api/play/d/'))
  ) {
    return 'card';
  }
  return undefined;
}

export interface SecurityHooksOptions {
  config: AppConfig;
}

export function registerSecurityHooks(app: FastifyInstance, config: AppConfig): void {
  const { rateLimit } = config.server;
  const limiters: Record<RateLimitCategory, SlidingWindowLimiter> = {
    join: new SlidingWindowLimiter(rateLimit.joinPerMin, MINUTE_MS),
    shortcode: new SlidingWindowLimiter(rateLimit.shortcodePerMin, MINUTE_MS),
    card: new SlidingWindowLimiter(rateLimit.cardPerMin, MINUTE_MS),
  };

  app.addHook('onRequest', async (request, reply) => {
    applySecurityHeaders(request, reply);
    applyCorsHeaders(request, reply, config);

    const pathname = pathnameOf(request.url);

    // CORS preflight: only answered for `/api/*` with an allowlisted Origin.
    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      const origin = request.headers.origin;
      if (typeof origin === 'string' && isAllowedOrigin(config, origin)) {
        setHeader(reply, 'access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        setHeader(reply, 'access-control-allow-headers', 'content-type, x-wtm-csrf, authorization');
        setHeader(reply, 'access-control-max-age', '600');
        reply.code(204).send();
        return;
      }
      // Not a permitted cross-origin preflight; no ACAO is emitted.
      reply.code(404).send();
      return;
    }

    const category = rateLimitCategory(request.method, pathname);
    if (category) {
      const limiter = limiters[category];
      if (!limiter.allow(request.ip)) {
        const retryAfterSec = Math.max(1, limiter.retryAfterSec(request.ip));
        setHeader(reply, 'retry-after', String(retryAfterSec));
        throw new AppError(
          'RATE_LIMITED',
          429,
          '操作太频繁了，请稍等一会儿再试',
          true,
        );
      }
    }
  });

  // Backstop for regular responses; hijacked responses are covered above.
  app.addHook('onSend', async (request, reply, payload) => {
    applySecurityHeaders(request, reply);
    applyCorsHeaders(request, reply, config);
    return payload;
  });
}

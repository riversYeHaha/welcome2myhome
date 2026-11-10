import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { findChrome, renderPdfFromHtml } from '../../src/server/services/print-pdf';
import { renderCardsPrintPage } from '../../src/server/views/cards-print';
import type { HostDoll, HostRoom } from '../../src/shared/host';
import { DEFAULT_FINALE } from '../../src/shared/finale';
import { makeTestApp, setupHost, type TestApp } from '../helpers/test-app';

const contexts: TestApp[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close();
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

const ROOM: HostRoom = {
  room_id: 'r_test',
  room_code: '123456',
  title: '测试的家',
  status: 'live',
  game_mode: 'solo',
  default_level_type: 'bonus_quiz',
  lan_ip: '192.168.1.10',
  port: 8080,
  finale: DEFAULT_FINALE,
};

const DOLL: HostDoll = {
  doll_id: 'd_1',
  room_id: 'r_test',
  name: '阿黄',
  tagline: '',
  sort_order: 0,
  card_token: 'token123456',
  short_code: 'ABC123',
  clue: '在厨房',
  hide_hint: '',
  silhouette_url: '',
  level_type: 'bonus_quiz',
  next_clue: null,
  egg_enabled: false,
  e1_effect: 'starlight',
  e1_sound: true,
  riddle_type: null,
  question: '',
  options: [],
  hint: '',
  wrong_text: '',
  max_attempts: 0,
  answer_configured: false,
  synonyms: [],
  base_story: '',
  base_caption: '',
  base_model_url: '',
  base_photo_url: '',
  secret_model_url: null,
  secret_story: '',
  secret_whisper: '',
  secret_effect: 'golden_gather',
  secret_star: true,
  gen_status: 'preset',
};

describe('cards print view for PDF', () => {
  it('embeds QR images and drops toolbar/scripts in PDF mode', () => {
    const html = renderCardsPrintPage(ROOM, [DOLL], {
      forPdf: true,
      qr: {
        welcome: 'data:image/png;base64,iVBORw0KGgo=',
        dolls: { d_1: 'data:image/png;base64,iVBORw0KGgo=' },
      },
    });

    expect(html).toContain('data:image/png;base64');
    expect(html).not.toContain('/api/cards/welcome.png');
    expect(html).not.toContain('/api/cards/d_1/qr.png');
    expect(html).not.toContain('id="print-button"');
    expect(html).not.toContain('/print.js');
    expect(html).toContain('class="sheet"');
  });

  it('keeps the interactive toolbar for the browser print page', () => {
    const html = renderCardsPrintPage(ROOM, [DOLL]);
    expect(html).toContain('id="print-button"');
    expect(html).toContain('/print.js');
    expect(html).toContain('/api/cards/welcome.png');
  });
});

describe('print-pdf chrome lookup', () => {
  it('returns null when no candidate exists', () => {
    expect(findChrome({ chromePath: '/nonexistent/chrome', candidates: [], env: {} })).toBeNull();
  });

  it('reports PRINT_UNAVAILABLE without a browser', async () => {
    const context = await makeTestApp();
    contexts.push(context);

    await expect(
      renderPdfFromHtml(context.config, '<html><body>x</body></html>', {
        chromePath: '/nonexistent/chrome',
        candidates: [],
        env: {},
      }),
    ).rejects.toMatchObject({ code: 'PRINT_UNAVAILABLE', statusCode: 503 });
  });
});

const chrome = findChrome();

describe('cards PDF endpoint', () => {
  it.skipIf(!chrome)(
    'renders an A4 PDF for an authenticated host',
    async () => {
      const context = await makeTestApp();
      contexts.push(context);
      const host = await setupHost(context.app);
      context.db
        .prepare(
          `INSERT INTO dolls (doll_id, room_id, name, card_token, short_code, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'd_pdf',
          host.room.room_id,
          '阿黄',
          'token_pdf_1',
          'PDF123',
          new Date().toISOString(),
          new Date().toISOString(),
        );

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/cards/pdf',
        headers: { cookie: host.cookie },
      });

      expect(response.statusCode).toBe(200);
      expect(String(response.headers['content-type'])).toContain('application/pdf');
      expect(String(response.headers['content-disposition'])).toContain('.pdf');
      expect(response.rawPayload.subarray(0, 5).toString('utf8')).toBe('%PDF-');
      expect(response.rawPayload.length).toBeGreaterThan(2000);

      const files = existsSync(context.config.paths.exports);
      expect(files).toBe(true);
    },
    60_000,
  );

  it('requires the host session', async () => {
    const context = await makeTestApp();
    contexts.push(context);
    const response = await context.app.inject({ method: 'GET', url: '/api/cards/pdf' });
    expect(response.statusCode).toBe(401);
  });
});

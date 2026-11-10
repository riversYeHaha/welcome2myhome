import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * T1301/T1304: one guest walks the whole P0 chain on a mobile viewport, from
 * the welcome QR to the share card, while the host board follows along.
 *
 * Runs against the throwaway E2E server (see tests/e2e/start-server.ts).
 */

const SCREENSHOTS = 'docs/screenshots';

function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

test.describe.configure({ mode: 'serial' });

test('host sets up a room and both cards', async ({ page }) => {
  mkdirSync(SCREENSHOTS, { recursive: true });
  const errors = trackConsole(page);

  await page.goto('/host/');
  await page.getByLabel('房间标题').fill('E2E 的家');
  await page.getByLabel(/PIN/).fill('2468');
  await page.getByRole('button', { name: '创建房间并进入' }).click();

  await expect(page.getByRole('heading', { name: 'E2E 的家' })).toBeVisible();

  for (const name of ['阿黄', '阿花']) {
    await page.getByPlaceholder('新成员名字').fill(name);
    await page.getByRole('button', { name: '仅创建' }).click();
    await expect(page.locator('.doll-card', { hasText: name })).toBeVisible();
  }

  expect(errors.filter((item) => item.includes('Content Security Policy'))).toEqual([]);
});

test('guest scans, collects, reaches the finale and shares a card', async ({
  browser,
  page,
}) => {
  // Each Playwright test gets a fresh cookie jar: log the host in first.
  await page.goto('/host/');
  await page.getByLabel(/PIN/).fill('2468');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: 'E2E 的家' })).toBeVisible();

  const hostRequest = page.context().request;
  const me = await (await hostRequest.get('/api/host/me')).json();
  const csrf: string = me.csrfToken;
  const roomId: string = me.room.room_id;
  const roomCode: string = me.room.room_code;

  const detail = await (await hostRequest.get(`/api/room/${roomId}`)).json();
  expect(detail.dolls).toHaveLength(2);
  const [first, second] = detail.dolls as Array<{ card_token: string; name: string }>;

  const live = await hostRequest.patch(`/api/room/${roomId}/status`, {
    data: { status: 'live' },
    headers: { 'x-wtm-csrf': csrf },
  });
  expect(live.ok()).toBe(true);

  const finale = await hostRequest.patch(`/api/room/${roomId}/finale`, {
    data: {
      enabled: true,
      trigger: { type: 'all_collected', value: null },
      title: '你今晚见到了我们全家',
      body: '最后这一位，是一直在厨房忙的那个人。',
      image_url: null,
      model_url: null,
      reward_note: '拿着这一页去找主人，换一张贴纸',
      share_caption: '今晚我认识了 2 个人',
    },
    headers: { 'x-wtm-csrf': csrf },
  });
  expect(finale.ok()).toBe(true);

  const origin = new URL(page.url()).origin;
  const guest = await browser.newContext({
    baseURL: origin,
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const guestPage = await guest.newPage();
  const guestErrors = trackConsole(guestPage);

  // Welcome code → nickname.
  await guestPage.goto(`/join?r=${roomCode}`);
  await guestPage.getByLabel('昵称').fill('小林');
  await guestPage.getByRole('button', { name: '进入我的家' }).click();
  // '/' now routes a signed-in guest straight to the collection (welcome code).
  await expect(guestPage).toHaveURL(/\/collection$/);
  await expect(guestPage.getByRole('heading', { name: /今晚，你见到了 0 \/ 2 位/ })).toBeVisible();

  // Card 1: E1 settles immediately under reduced motion, then auto-collects.
  await guestPage.goto(`/d/${encodeURIComponent(first!.card_token)}`);
  await expect(guestPage.getByRole('heading', { name: first!.name })).toBeVisible();
  await expect(guestPage.getByText('已收入收藏册')).toBeVisible({ timeout: 20_000 });

  // Tap the doll: a preset line appears in a bubble (D).
  await guestPage.locator('.silhouette canvas').click({ position: { x: 60, y: 70 } });
  await expect(guestPage.locator('.doll-bubble.doll-bubble-show')).toBeVisible();
  await expect(guestPage.locator('.doll-bubble')).toContainText(/./);

  await guestPage.screenshot({ path: `${SCREENSHOTS}/e1-card.png`, fullPage: true });

  // Card 2.
  await guestPage.goto(`/d/${encodeURIComponent(second!.card_token)}`);
  await expect(guestPage.getByText('已收入收藏册')).toBeVisible({ timeout: 20_000 });

  // Collection + finale (all_collected).
  await guestPage.goto('/collection');
  await expect(
    guestPage.getByRole('heading', { name: /今晚，你见到了 2 \/ 2 位/ }),
  ).toBeVisible();

  await guestPage.goto('/finale');
  await expect(
    guestPage.getByRole('heading', { name: '你今晚见到了我们全家' }),
  ).toBeVisible();
  await expect(guestPage.getByRole('link', { name: '保存分享卡' })).toBeVisible();
  await guestPage.screenshot({ path: `${SCREENSHOTS}/finale.png`, fullPage: true });

  const share = await guest.request.get('/api/share/card.png');
  expect(share.status()).toBe(200);
  expect(share.headers()['content-type']).toContain('image/png');
  const shareBytes = await share.body();
  expect(shareBytes.byteLength).toBeGreaterThan(10_000);
  writeFileSync(`${SCREENSHOTS}/share-card.png`, shareBytes);

  // Host board reflects the guest within its SSE/5s window.
  await page.goto('/host/');
  await expect(page.getByRole('heading', { name: '现场看板' })).toBeVisible();
  await expect(
    page.locator('.stat', { hasText: '已收藏' }).locator('.stat-value'),
  ).toHaveText('2', { timeout: 15_000 });
  await expect(
    page.locator('.stat', { hasText: '达成终局' }).locator('.stat-value'),
  ).toHaveText('1');
  await expect(page.locator('.board-row', { hasText: '小林' })).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/board.png`, fullPage: true });

  // Self check must agree that everything is ready.
  await page.getByRole('button', { name: '运行自检' }).click();
  await expect(page.getByText('全部检查通过，可以开局。')).toBeVisible();

  // FR-09: server-side PDF is generated from the same print stylesheet.
  const pdf = await page.context().request.get('/api/cards/pdf');
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString('utf8')).toBe('%PDF-');

  expect(guestErrors.filter((item) => item.includes('Content Security Policy'))).toEqual([]);
  await guest.close();
});

test('short code entry lands on the card without scanning', async ({ browser, page }) => {
  await page.goto('/host/');
  await page.getByLabel(/PIN/).fill('2468');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: 'E2E 的家' })).toBeVisible();

  const me = await (await page.context().request.get('/api/host/me')).json();
  const detail = await (
    await page.context().request.get(`/api/room/${me.room.room_id}`)
  ).json();
  const shortCode = detail.dolls[0].short_code as string;
  const token = detail.dolls[0].card_token as string;
  const code = me.room.room_code as string;
  const origin = new URL(page.url()).origin;

  const guestContext = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const guestPage = await guestContext.newPage();
  await guestPage.goto(`/join?r=${code}`);
  await guestPage.getByLabel('昵称').fill('短码客人');
  await guestPage.getByLabel('卡片短码（可选）').fill(shortCode.toLowerCase());
  await guestPage.getByRole('button', { name: '进入我的家' }).click();

  await expect(guestPage).toHaveURL(new RegExp(`/d/${token}$`));
  await expect(guestPage.getByRole('heading', { name: detail.dolls[0].name })).toBeVisible();
  await guestContext.close();
});

test('no-JS guest can still collect with the fallback form', async ({ browser, page }) => {
  await page.goto('/host/');
  await page.getByLabel(/PIN/).fill('2468');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: 'E2E 的家' })).toBeVisible();

  const me = await (await page.context().request.get('/api/host/me')).json();
  const detail = await (
    await page.context().request.get(`/api/room/${me.room.room_id}`)
  ).json();
  const code = me.room.room_code as string;
  const token = detail.dolls[0].card_token as string;

  const origin = new URL(page.url()).origin;
  const noJs = await browser.newContext({
    baseURL: origin,
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const guest = await noJs.newPage();
  await guest.goto(`/join?r=${code}`);
  await guest.getByLabel('昵称').fill('阿明');
  await guest.getByRole('button', { name: '进入我的家' }).click();
  await guest.goto(`/d/${encodeURIComponent(token)}`);
  await guest.getByRole('button', { name: '收下 TA' }).click();
  await expect(guest.getByText('已收入收藏册')).toBeVisible();

  await guest.goto('/collection');
  await expect(guest.getByRole('heading', { name: /今晚，你见到了/ })).toBeVisible();
  await noJs.close();
});

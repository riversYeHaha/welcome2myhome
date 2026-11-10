import type { HostDoll, HostRoom } from '../../shared/host';
import { escapeHtml } from './html';

interface PrintCard {
  kind: 'welcome' | 'doll';
  qrUrl: string;
  shortCode: string;
  clue: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    pages.push(items.slice(index, index + size));
  }
  return pages.length > 0 ? pages : [[]];
}

function renderCard(card: PrintCard): string {
  if (card.kind === 'welcome') {
    return `<article class="card welcome">
  <p class="eyebrow">欢迎来到我的家</p>
  <h2>扫码，走进这个家</h2>
  <img class="qr" src="${escapeHtml(card.qrUrl)}" alt="欢迎码" />
  <p class="code">${escapeHtml(card.shortCode)}</p>
  <p class="clue">请连接主人家 WiFi，用 Safari / Chrome 打开</p>
</article>`;
  }

  return `<article class="card">
  <div class="silhouette"><span>?</span></div>
  <img class="qr" src="${escapeHtml(card.qrUrl)}" alt="人偶二维码" />
  <p class="code">${escapeHtml(card.shortCode)}</p>
  <p class="clue">${escapeHtml(card.clue || '扫我，拆开一个彩蛋')}</p>
</article>`;
}

/**
 * A4 print sheet: 2 × 2 cards per page, 80 × 120 mm each. This is the K6
 * fallback (browser print) and intentionally avoids bundled fonts/PDF deps.
 */
export interface CardsPrintOptions {
  /** Pre-rendered QR data URLs; defaults to the public PNG endpoints. */
  qr?: { welcome?: string; dolls?: Record<string, string> };
  /** Self-contained document (no toolbar/scripts) for server-side PDF. */
  forPdf?: boolean;
}

export function renderCardsPrintPage(
  room: HostRoom,
  dolls: HostDoll[],
  options: CardsPrintOptions = {},
): string {
  const { qr = {}, forPdf = false } = options;
  const cards: PrintCard[] = [
    {
      kind: 'welcome',
      qrUrl: qr.welcome ?? '/api/cards/welcome.png',
      shortCode: room.room_code,
      clue: '',
    },
    ...dolls.map(
      (doll): PrintCard => ({
        kind: 'doll',
        qrUrl: qr.dolls?.[doll.doll_id] ?? `/api/cards/${encodeURIComponent(doll.doll_id)}/qr.png`,
        shortCode: doll.short_code,
        clue: doll.clue,
      }),
    ),
  ];

  const pages = chunk(cards, 4)
    .map(
      (page, index) => `<section class="sheet" aria-label="第 ${index + 1} 页">
${page.map(renderCard).join('\n')}
</section>`,
    )
    .join('\n');

  const lanHint = room.lan_ip
    ? `二维码地址：http://${escapeHtml(room.lan_ip)}:${room.port}`
    : '尚未设置局域网地址：请先在主人端保存 LAN IP，再重新打印。';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>打印卡片 · ${escapeHtml(room.title)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #eee;
    color: #111;
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
  }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 10px 16px; background: #1b1512; color: #f5ece2;
  }
  .toolbar p { margin: 0; font-size: 12px; color: #b9a99a; }
  .toolbar button {
    padding: 8px 18px; border: 0; border-radius: 999px;
    background: #e5b567; color: #231607; font-weight: 600; cursor: pointer;
  }
  .sheet {
    width: 190mm;
    min-height: 277mm;
    margin: 10mm auto;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(2, 80mm);
    grid-auto-rows: 120mm;
    gap: 10mm;
    justify-content: center;
    background: #fff;
  }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 6mm;
    border: 1px dashed #bbb;
    text-align: center;
    break-inside: avoid;
  }
  .card .silhouette {
    width: 48mm; height: 48mm;
    border-radius: 50% 50% 45% 45%;
    background: #111;
    display: grid; place-items: center;
  }
  .card .silhouette span { color: #fff; font-size: 28pt; font-weight: 700; }
  .card .qr { width: 32mm; height: 32mm; image-rendering: pixelated; }
  .card .code {
    margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 15pt; letter-spacing: 0.16em; font-weight: 700;
  }
  .card .clue { margin: 0; font-size: 9pt; color: #444; line-height: 1.4; }
  .card .eyebrow {
    margin: 0; font-size: 9pt; letter-spacing: 0.16em; color: #a8732a;
  }
  .card h2 { margin: 2mm 0; font-size: 13pt; font-weight: 600; }
  .welcome { border-style: solid; border-color: #a8732a; }
  @media screen {
    .sheet { box-shadow: 0 8px 30px rgba(0,0,0,.18); }
  }
  @media print {
    body { background: #fff; }
    .toolbar { display: none; }
    .sheet { margin: 0; box-shadow: none; page-break-after: always; }
    .sheet:last-child { page-break-after: auto; }
  }
</style>
</head>
<body>
  ${
    forPdf
      ? ''
      : `<div class="toolbar">
    <div>
      <strong>卡片打印预览</strong>
      <p>${lanHint}</p>
    </div>
    <button type="button" id="print-button">打印 / 另存为 PDF</button>
  </div>`
  }
  ${pages}
  ${forPdf ? '' : '<script type="module" src="/print.js"></script>'}
</body>
</html>`;
}

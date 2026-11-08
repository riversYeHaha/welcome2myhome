import sharp from 'sharp';

export interface ShareCardData {
  roomTitle: string;
  guestName: string;
  found: number;
  total: number;
  eggs: number;
  names: string[];
  finaleTitle: string | null;
  date: string;
}

const WIDTH = 1080;
const HEIGHT = 1440;
const FONT = "'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Microsoft YaHei', sans-serif";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clip(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

/** Small deterministic decorations so the card feels handmade, not generated. */
function confetti(): string {
  const dots = [
    [96, 210, 7, '#e7c58f'],
    [972, 168, 9, '#d9a15a'],
    [150, 1260, 6, '#e7c58f'],
    [930, 1180, 8, '#cfa066'],
    [88, 720, 5, '#e9cfa8'],
    [1000, 800, 6, '#e9cfa8'],
    [210, 112, 4, '#c9a06a'],
    [860, 96, 5, '#c9a06a'],
    [64, 1010, 4, '#d8b98d'],
    [1016, 1000, 5, '#d8b98d'],
  ];
  return dots
    .map(
      ([x, y, r, fill]) =>
        `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" opacity="0.75" />`,
    )
    .join('');
}

/**
 * Square-ish share card (1080x1440) rendered as SVG → PNG. Only names the guest
 * already collected appear; answers, photos and tokens never reach the image.
 */
export function buildShareSvg(data: ShareCardData): string {
  const headline = data.found >= data.total && data.total > 0
    ? '今晚，我见到了全家'
    : `今晚我认识了 ${data.found} 个人`;

  const subline = data.finaleTitle
    ? clip(data.finaleTitle, 18)
    : data.found >= data.total
      ? '收藏册已经集满'
      : `收藏册 ${data.found} / ${data.total}`;

  const names = data.names.length > 0 ? data.names : ['还没有收集到成员'];
  const visible = names.slice(0, 12);
  const overflow = names.length - visible.length;

  // Locked members stay anonymous dashed slots, so the card shows progress.
  const placeholders = Math.max(0, Math.min(12, data.total) - visible.length);

  const cols = 3;
  const pillW = 268;
  const pillH = 84;
  const gapX = 26;
  const gapY = 22;
  const gridW = cols * pillW + (cols - 1) * gapX;
  const startX = (WIDTH - gridW) / 2;
  const slots = visible.length + placeholders;
  const rows = Math.ceil(slots / cols);
  const startY = 470 + Math.max(0, 3 - rows) * 54;

  function pill(index: number, label: string, filled: boolean): string {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const x = startX + col * (pillW + gapX);
    const y = startY + row * (pillH + gapY);
    const rect = filled
      ? `fill="#fffaf1" stroke="#e2c9a6" stroke-width="2"`
      : `fill="none" stroke="#ddc9ab" stroke-width="2" stroke-dasharray="7 7"`;
    const text = filled ? '#5a4632' : '#b7a48c';
    return `<g>
  <rect x="${x}" y="${y}" width="${pillW}" height="${pillH}" rx="42" ${rect} />
  <text x="${x + pillW / 2}" y="${y + pillH / 2 + 13}" font-family="${FONT}"
    font-size="34" fill="${text}" text-anchor="middle">${escapeXml(label)}</text>
</g>`;
  }

  const pills =
    visible.map((name, index) => pill(index, clip(name, 6), true)).join('') +
    Array.from({ length: placeholders }, (_unused, offset) =>
      pill(visible.length + offset, '？', false),
    ).join('');

  const overflowText = overflow > 0
    ? `<text x="${WIDTH / 2}" y="${startY + rows * (pillH + gapY) + 26}" font-family="${FONT}"
        font-size="28" fill="#96806a" text-anchor="middle">还有 ${overflow} 位在家里等你</text>`
    : '';

  const eggsY = startY + rows * (pillH + gapY) + (overflow > 0 ? 74 : 34);
  const eggsText = data.eggs > 0
    ? `<text x="${WIDTH / 2}" y="${eggsY}" font-family="${FONT}" font-size="32"
        fill="#a8732a" text-anchor="middle">★ 还解开了 ${data.eggs} 个彩蛋</text>`
    : '';

  const guestY = eggsY + (data.eggs > 0 ? 66 : 0);
  const guest = data.guestName
    ? `<text x="${WIDTH / 2}" y="${guestY}" font-family="${FONT}" font-size="30"
        fill="#7a6a5d" text-anchor="middle">—— ${escapeXml(clip(data.guestName, 10))} 的收藏册</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#fffaf2" />
      <stop offset="0.55" stop-color="#f8efe1" />
      <stop offset="1" stop-color="#f1e2cd" />
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.28" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.85" />
      <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
    </radialGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)" />
  ${confetti()}

  <text x="${WIDTH / 2}" y="150" font-family="${FONT}" font-size="26" letter-spacing="8"
    fill="#a8732a" text-anchor="middle">WELCOME TO MY HOME</text>
  <text x="${WIDTH / 2}" y="214" font-family="${FONT}" font-size="30"
    fill="#96806a" text-anchor="middle">${escapeXml(clip(data.roomTitle, 16))}</text>

  <text x="${WIDTH / 2}" y="330" font-family="${FONT}" font-size="58" font-weight="600"
    fill="#2b211b" text-anchor="middle">${escapeXml(headline)}</text>
  <text x="${WIDTH / 2}" y="392" font-family="${FONT}" font-size="30"
    fill="#a8732a" text-anchor="middle">${escapeXml(subline)}</text>

  <path d="M ${WIDTH / 2 - 60} 424 L ${WIDTH / 2 + 60} 424" stroke="#d9bd93" stroke-width="2" />

  ${pills}
  ${overflowText}
  ${eggsText}
  ${guest}

  <text x="${WIDTH / 2}" y="1180" font-family="${FONT}" font-size="28"
    fill="#b7a48c" text-anchor="middle">有些家人，是走进去才认识的</text>

  <text x="${WIDTH / 2}" y="1330" font-family="${FONT}" font-size="26"
    fill="#96806a" text-anchor="middle">${escapeXml(data.date)} · 一晚上的家</text>
</svg>`;
}

export async function renderShareCard(data: ShareCardData): Promise<Buffer> {
  const svg = buildShareSvg(data);
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

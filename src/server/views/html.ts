const BASE_STYLES = `
:root{color-scheme:dark;--bg:#1b1512;--panel:#241c17;--ink:#f5ece2;--dim:#b9a99a;--gold:#e5b567;--ok:#7ed6a5;--err:#f28b82}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{min-height:100dvh;display:grid;place-items:center;padding:24px;background:radial-gradient(120% 80% at 50% 0%,#33261d 0,transparent 60%),radial-gradient(80% 60% at 80% 100%,#2a1e18 0,transparent 70%),var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif;line-height:1.65}
main{width:min(560px,100%);padding:28px 22px;text-align:center}
.eyebrow{margin:0 0 10px;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold)}
h1{margin:0 0 8px;font-size:clamp(28px,8vw,40px);letter-spacing:.04em}
.tagline{margin:0 0 18px;color:var(--dim)}
.silhouette{width:150px;height:190px;margin:0 auto 18px;border-radius:18px;background:linear-gradient(180deg,#3a2c23,#221a15);border:1px solid #403127;display:grid;place-items:center;color:#6d5a4d;font-size:12px;overflow:hidden}
.silhouette img{width:100%;height:100%;object-fit:contain}
.story{color:var(--dim);font-size:15px;margin:0 0 22px}
.collected{display:inline-block;padding:10px 16px;border-radius:999px;background:rgba(126,214,165,.12);color:var(--ok);border:1px solid rgba(126,214,165,.3);font-size:14px}
button{appearance:none;border:0;border-radius:999px;padding:12px 22px;background:var(--gold);color:#2b1d10;font-size:15px;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.06)}
.teaser{margin:22px 0 0;color:var(--dim);font-size:13px}
.join{width:min(420px,100%);padding:30px 24px;background:var(--panel);border:1px solid #3a2c23;border-radius:18px}
label{display:block;text-align:left;font-size:13px;color:var(--dim);margin:14px 0 6px}
input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #4a382c;background:#1a1310;color:var(--ink);font-size:16px}
form{margin:0}
.error{color:var(--err);font-size:14px;margin:10px 0 0}
.foot{margin-top:22px;font-size:12px;color:#8d7a6b}
a{color:var(--gold);text-decoration:none}a:hover{text-decoration:underline}
`;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

export interface PageOptions {
  title: string;
  body: string;
  statusHint?: string;
}

export function renderPage(options: PageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#1b1512" />
<title>${escapeHtml(options.title)}</title>
<style>${BASE_STYLES}</style>
</head>
<body>
${options.body}
</body>
</html>`;
}

export function renderErrorPage(options: {
  title: string;
  message: string;
  backHref?: string;
}): string {
  const backHref = options.backHref ?? '/';
  return renderPage({
    title: options.title,
    body: `<main>
  <p class="eyebrow">欢迎来到我的家</p>
  <h1>${escapeHtml(options.title)}</h1>
  <p class="story">${escapeHtml(options.message)}</p>
  <a class="foot" href="${escapeHtml(backHref)}">返回首页</a>
</main>`,
  });
}

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
  /** Same-origin module scripts, loaded after the body. */
  scripts?: string[];
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
${(options.scripts ?? []).map((script) => `<script type="module" src="${escapeHtml(script)}"></script>`).join('\n')}
</body>
</html>
/* --- E1 effect layer (T501–T506) --- */
.card{position:relative;transition:transform .3s cubic-bezier(.2,.8,.2,1)}
.e1-ready .card[data-e1="flip"]{transform:rotateY(-12deg) scale(.985)}
.e1-ready .card[data-e1="burst"],.e1-ready .card[data-e1="dissolve"],.e1-ready .card[data-e1="reveal"],.e1-ready .card[data-e1="settled"]{transform:none}
.e1-ready .card h1,.e1-ready .card .tagline,.e1-ready .card .story,.e1-ready .card form,.e1-ready .card .collected,.e1-ready .card .teaser{opacity:0;transform:translateY(8px);transition:opacity .4s ease,transform .4s ease}
.e1-ready .card[data-e1="reveal"] h1,.e1-ready .card[data-e1="reveal"] .tagline,.e1-ready .card[data-e1="reveal"] .story,.e1-ready .card[data-e1="reveal"] form,.e1-ready .card[data-e1="reveal"] .collected,.e1-ready .card[data-e1="reveal"] .teaser,
.e1-ready .card[data-e1="settled"] h1,.e1-ready .card[data-e1="settled"] .tagline,.e1-ready .card[data-e1="settled"] .story,.e1-ready .card[data-e1="settled"] form,.e1-ready .card[data-e1="settled"] .collected,.e1-ready .card[data-e1="settled"] .teaser{opacity:1;transform:none}
.e1-ready .card .silhouette{transition:opacity .75s ease,transform 1s ease,filter .75s ease}
.e1-ready .card[data-e1="dissolve"] .silhouette{opacity:.25;transform:translateY(-8px) scale(1.04);filter:blur(2px)}
.e1-ready .card[data-e1="settled"] .silhouette{opacity:1;transform:none;filter:none}
.e1-degraded .card h1,.e1-degraded .card .tagline,.e1-degraded .card .story,.e1-degraded .card form,.e1-degraded .card .collected,.e1-degraded .card .teaser{opacity:1!important;transform:none!important}
.e1-sweep{position:absolute;inset:0;overflow:hidden;border-radius:18px;pointer-events:none}
.e1-sweep::after{content:'';position:absolute;top:-60%;left:-70%;width:45%;height:220%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.7),transparent);transform:skewX(-18deg);animation:e1-sweep .55s ease-out forwards}
@keyframes e1-sweep{to{left:125%}}
.e1-particles{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:20}
.e1-skip{position:fixed;right:16px;bottom:16px;z-index:30;padding:8px 14px;border-radius:999px;border:1px solid #4a382c;background:rgba(27,21,18,.8);color:var(--dim);font-size:12px;cursor:pointer}
.e1-replay{margin:14px auto 0;display:inline-block;padding:9px 18px;border-radius:999px;border:1px solid rgba(229,181,103,.5);background:transparent;color:var(--gold);font-size:14px;cursor:pointer}
.e1-sound{position:fixed;left:16px;bottom:16px;z-index:30;padding:8px 14px;border-radius:999px;border:1px solid rgba(229,181,103,.5);background:rgba(27,21,18,.85);color:var(--gold);font-size:12px;cursor:pointer}
.e1-ready .card .hook{opacity:0}
.e1-ready .card[data-e1="settled"] .hook{opacity:1;transition:opacity .3s ease}

/* --- collection / finale (T603) --- */
.guest.collection{width:min(760px,100%)}
.collection-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin:20px 0}
.collect-card{padding:10px;border:1px solid #3a2c23;border-radius:14px;background:rgba(36,28,23,.85);text-align:center}
.collect-card.locked{opacity:.62}
.silhouette.small{width:100%;height:120px;margin:0 0 8px;border-radius:12px}
.collection-grid h2{font-size:15px;margin:4px 0}
.collection-grid .tagline{font-size:12px;margin:2px 0}
.collection-grid .story{font-size:12px;margin:4px 0;max-height:3.6em;overflow:hidden}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:rgba(229,181,103,.15);color:var(--gold);font-size:11px}
.star{color:var(--gold)}
.finale-teaser{margin-top:18px;padding:16px;border:1px solid #3a2c23;border-radius:14px;background:var(--panel)}
.finale-teaser h2{margin:0 0 6px;font-size:15px}
.finale-image{max-width:100%;border-radius:14px;margin:12px 0}
.reward{margin:14px 0;padding:10px;border:1px dashed rgba(229,181,103,.5);border-radius:10px;color:var(--gold);font-size:14px}
.finale h1{font-size:clamp(24px,7vw,36px)}

/* --- E2 quiz & secret (T703/T704) --- */
.egg-open{display:inline-block;margin-top:16px;padding:10px 18px;border-radius:999px;border:1px solid rgba(229,181,103,.55);background:transparent;color:var(--gold);font-size:14px;cursor:pointer}
.egg-open[hidden]{display:none}
.egg-panel{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);width:min(440px,calc(100vw - 28px));z-index:40;padding:18px;border-radius:16px;border:1px solid #4a382c;background:rgba(30,22,18,.97);box-shadow:0 18px 50px rgba(0,0,0,.45);text-align:left}
.egg-panel h2{margin:4px 0 10px;font-size:18px}
.egg-eyebrow{margin:0;font-size:11px;letter-spacing:.16em;color:var(--gold);text-transform:uppercase}
.egg-question{margin:0 0 10px;font-size:14px;color:var(--ink)}
.egg-options{display:flex;flex-direction:column;gap:6px}
.egg-option{width:100%;text-align:left;padding:10px 12px;border-radius:10px;border:1px solid #4a382c;background:#1a1310;color:var(--ink);font-size:14px;cursor:pointer}
.egg-option:hover{border-color:var(--gold)}
.egg-option:disabled{opacity:.5;cursor:wait}
.egg-input{display:flex;gap:8px}
.egg-input input{flex:1;margin-top:0}
.egg-feedback{min-height:20px;margin:10px 0 0;font-size:13px;color:var(--dim)}
.egg-actions{display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap}
.egg-actions button{padding:7px 14px;font-size:12px}
.egg-close{margin-left:auto;background:transparent;border:1px solid #4a382c;color:var(--dim)}
.egg-hint{color:var(--gold);font-size:12px;margin:8px 0 0}
.egg-panel.golden{border-color:rgba(229,181,103,.8);animation:egg-gather .7s ease-out}
@keyframes egg-gather{0%{box-shadow:0 0 0 18px rgba(229,181,103,0);transform:translateX(-50%) scale(1.03)}60%{box-shadow:0 0 0 2px rgba(229,181,103,.45),0 0 46px rgba(229,181,103,.35)}100%{box-shadow:0 18px 50px rgba(0,0,0,.45);transform:translateX(-50%) scale(1)}}
.egg-secret-story{margin:8px 0;color:var(--dim);font-size:14px;line-height:1.7}
.egg-whisper{margin:10px 0;padding:8px 10px;border-radius:10px;background:rgba(229,181,103,.08);color:var(--gold);font-size:13px}
.egg-star{color:var(--gold);font-size:13px;margin-top:6px}

/* --- 3D doll viewer (T601) --- */
.silhouette{position:relative;overflow:hidden}
.silhouette canvas{position:absolute;inset:0;width:100%!important;height:100%!important;display:block}
.silhouette.viewer-ready img,.silhouette.viewer-ready span{opacity:0}
.view-doll{margin-top:8px;padding:6px 12px;border-radius:999px;border:1px solid rgba(229,181,103,.5);background:transparent;color:var(--gold);font-size:12px;cursor:pointer}
.viewer-overlay{position:fixed;inset:0;z-index:60;background:rgba(10,8,6,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px}
.viewer-stage{width:min(72vw,72vh);height:min(72vw,72vh);min-width:220px;min-height:220px}
.viewer-title{margin:0;color:var(--ink);font-size:14px;letter-spacing:.08em}
.viewer-close{padding:8px 18px;border-radius:999px;border:1px solid #4a382c;background:transparent;color:var(--gold);cursor:pointer}
`;
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

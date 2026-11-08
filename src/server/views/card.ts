import type { E1View } from '../services/play';
import { escapeHtml, renderPage } from './html';

export interface CardPageOptions {
  view: E1View;
  token: string;
  collected: boolean;
  /** Host preview: no progress writes, no collect form. */
  preview?: boolean;
}

/** SSR E1 card page: content is complete without JavaScript (no-JS collect form). */
export function renderCardPage(options: CardPageOptions): string {
  const { view, token, collected, preview = false } = options;

  const silhouette = `<div class="silhouette"
    data-doll-id="${escapeHtml(view.doll_id)}"
    data-doll-model="${escapeHtml(view.base.model_url ?? '')}">
    ${
      view.silhouette_url
        ? `<img src="${escapeHtml(view.silhouette_url)}" alt="" />`
        : '<span aria-hidden="true">剪影</span>'
    }
  </div>`;

  const story = view.base.story
    ? `<p class="story">${escapeHtml(view.base.story).replace(/\n/g, '<br />')}</p>`
    : '';

  const action = preview
    ? `<p class="collected">预览模式 · 不会写入客人进度</p>`
    : collected
      ? `<p class="collected">已收入收藏册</p>`
      : `<form method="post" action="/d/${encodeURIComponent(token)}/collect">
      <button type="submit">收下 TA</button>
    </form>`;

  const teaser = view.level.riddle
    ? `<p class="teaser">还有一段藏起来的故事，等你自己来拆。</p>`
    : '';

  const body = `<main class="card"
  data-doll-id="${escapeHtml(view.doll_id)}"
  data-effect="${escapeHtml(view.level.e1.effect)}"
  data-sound="${view.level.e1.sound ? '1' : '0'}"
  data-state="${escapeHtml(view.progress.state)}"
  data-token="${escapeHtml(token)}"
  data-preview="${preview ? '1' : '0'}">
  <p class="eyebrow">拆开一个彩蛋</p>
  ${silhouette}
  <h1>${escapeHtml(view.name)}</h1>
  ${view.tagline ? `<p class="tagline">${escapeHtml(view.tagline)}</p>` : ''}
  ${story}
  ${action}
  ${teaser}
  ${
    view.level.riddle && view.progress.state !== 'egg_unlocked'
      ? '<button type="button" class="egg-open" data-mode="quiz" hidden>再听听 TA 的故事</button>'
      : ''
  }
  ${
    view.progress.state === 'egg_unlocked'
      ? '<button type="button" class="egg-open" data-mode="secret" hidden>看 TA 的秘密</button>'
      : ''
  }
  <p class="foot">${preview ? '主人预览 · ' : ''}E1 特效 T501 · 收藏册 T603</p>
</main>`;

  return renderPage({
    title: `${view.name} · 欢迎来到我的家`,
    body,
    scripts: ['/effect.js', '/viewer.js'],
  });
}

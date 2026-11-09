import type { GuestCollection } from '../../shared/guest';
import { escapeHtml, renderPage } from './html';

export function renderCollectionPage(data: GuestCollection): string {
  const cards = data.items
    .map((item) => {
      if (item.state === 'locked') {
        return `<article class="collect-card locked">
  <div class="silhouette small" aria-hidden="true">?</div>
  <p class="muted">还没见到</p>
</article>`;
      }

      const silhouette = item.thumbnail_url
        ? `<div class="silhouette small"><img src="${escapeHtml(item.thumbnail_url)}" alt="" /></div>`
        : `<div class="silhouette small" aria-hidden="true">剪影</div>`;

      const egg =
        item.egg === 'none'
          ? ''
          : `<span class="badge">彩蛋 ${item.egg === 'unlocked' ? '1/1' : '0/1'}</span>`;
      const star = item.star ? '<span class="star" title="已解锁秘密彩蛋">★</span>' : '';

      return `<article class="collect-card">
  ${silhouette}
  <h2>${escapeHtml(item.name ?? '')} ${star}</h2>
  ${item.tagline ? `<p class="tagline">${escapeHtml(item.tagline)}</p>` : ''}
  ${item.story ? `<p class="story">${escapeHtml(item.story)}</p>` : ''}
  <div class="badges">${egg}</div>
  <button type="button" class="view-doll"
    data-doll-id="${escapeHtml(item.doll_id)}"
    data-name="${escapeHtml(item.name ?? '')}"
    data-model-url="${escapeHtml(item.model_url ?? '')}"
    data-secret-model="${escapeHtml(item.secret_model_url ?? '')}">看看 TA</button>
</article>`;
    })
    .join('');

  const finale = data.finale.reached
    ? `<p class="tagline">终局已解锁。</p><a class="button" href="/finale">查看终局</a>`
    : data.finale.enabled
      ? `<p class="tagline">还差 ${data.finale.remaining} 位，终局就会打开。</p>`
      : '';

  const body = `<main class="guest collection">
  <p class="eyebrow">收藏册</p>
  <h1>今晚，你见到了 ${data.summary.found} / ${data.summary.total} 位</h1>
  <p class="tagline">彩蛋 ${data.summary.eggs} / ${data.summary.total}</p>
  <div class="collection-grid">${cards}</div>
  <section class="finale-teaser">
    <h2>终局</h2>
    ${finale}
  </section>
  <p class="share-row"><a class="button ghost" href="/api/share/card.png" download="welcome-home-share.png">保存分享卡</a></p>
  <p class="foot"><a href="/">回首页</a></p>
</main>`;

  return renderPage({ title: '收藏册 · 欢迎来到我的家', body, scripts: ['/viewer.js'] });
}

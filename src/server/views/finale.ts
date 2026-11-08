import type { GuestCollectionFinale } from '../../shared/guest';
import { escapeHtml, renderPage } from './html';

export function renderFinalePage(data: {
  reached: boolean;
  content: GuestCollectionFinale['content'];
  remaining: number;
}): string {
  if (!data.reached || !data.content) {
    return renderPage({
      title: '终局 · 欢迎来到我的家',
      body: `<main class="guest finale">
  <p class="eyebrow">终局</p>
  <h1>还差 ${data.remaining} 位</h1>
  <p class="tagline">继续找一找，屋里的成员还在等你。</p>
  <p class="foot"><a href="/collection">回收藏册</a></p>
</main>`,
    });
  }

  const content = data.content;
  return renderPage({
    title: '终局 · 欢迎来到我的家',
    body: `<main class="guest finale">
  <p class="eyebrow">终局</p>
  <h1>${escapeHtml(content.title)}</h1>
  <p class="story">${escapeHtml(content.body).replace(/\n/g, '<br />')}</p>
  ${content.image_url ? `<img class="finale-image" src="${escapeHtml(content.image_url)}" alt="" />` : ''}
  ${content.reward_note ? `<p class="reward">${escapeHtml(content.reward_note)}</p>` : ''}
  ${content.share_caption ? `<p class="tagline">${escapeHtml(content.share_caption)}</p>` : ''}
  <p class="share-row"><a class="button" href="/api/share/card.png" download="welcome-home-share.png">保存分享卡</a></p>
  <p class="foot"><a href="/collection">回收藏册</a></p>
</main>`,
  });
}

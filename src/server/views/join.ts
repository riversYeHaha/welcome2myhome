import { escapeHtml, renderPage } from './html';

export interface JoinPageOptions {
  roomCode?: string;
  shortCode?: string;
  next?: string;
  error?: string;
}

export function renderJoinPage(options: JoinPageOptions): string {
  const body = `<main class="join">
  <p class="eyebrow">欢迎来到我的家</p>
  <h1>先告诉我怎么称呼你</h1>
  <p class="tagline">今晚你会在家里找到几位成员。</p>
  <form method="post" action="/join">
    <input type="hidden" name="next" value="${escapeHtml(options.next ?? '/')}" />
    <label for="room_code">房间码</label>
    <input id="room_code" name="room_code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
      required value="${escapeHtml(options.roomCode ?? '')}" placeholder="426918" />
    <label for="nickname">昵称</label>
    <input id="nickname" name="nickname" maxlength="20" required placeholder="小林" />
    <label for="short_code">卡片短码（可选）</label>
    <input id="short_code" name="short_code" inputmode="text" autocomplete="off"
      pattern="[0-9A-Za-z]{6}" maxlength="6"
      value="${escapeHtml(options.shortCode ?? '')}" placeholder="4UZRJL" />
    <p class="hint">没有欢迎码时，输入卡片上的 6 位短码也能直接找到 TA。</p>
    ${options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ''}
    <button type="submit">进入我的家</button>
  </form>
  <p class="foot">请连接主人家 WiFi，并用 Safari / Chrome 打开本页。</p>
</main>`;

  return renderPage({ title: '进入 · 欢迎来到我的家', body });
}

import { useCallback, useEffect, useState } from 'react';
import type { BoardEventView, BoardSnapshot } from '@shared/board';
import type { ProgressState } from '@shared/levels';
import type { RoomStatus } from '@shared/contracts';
import { ApiError, hostApi } from './api';

const STATE_LABEL: Record<ProgressState, string> = {
  locked: '未发现',
  discovered: '已发现',
  collected: '已收藏',
  egg_answering: '答题中',
  egg_unlocked: '彩蛋已解',
};

const EVENT_LABEL: Record<string, string> = {
  guest_join: '有人进来了',
  card_scanned: '扫了一张卡',
  progress: '进度更新',
  egg_challenge_started: '开始答题',
  answer_submit: '提交答案',
  hint_used: '请求提示',
  egg2_unlocked: '解开彩蛋',
  egg1_played: '看完 E1',
  egg1_replayed: '重播 E1',
  finale_reached: '达成终局',
  session_complete: '走完全程',
  network_error: '网络异常',
  room_status: '房间状态变化',
  finale_open: '主人打开终局',
};

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function eventText(event: BoardEventView): string {
  const label = EVENT_LABEL[event.type] ?? event.type;
  const who = event.guest_name ?? '客人';
  const doll = event.doll_name ? ` · ${event.doll_name}` : '';
  if (event.type === 'answer_submit') {
    const correct = event.payload.correct === true;
    return `${who} 提交答案（${correct ? '答对' : '答错'}）${doll}`;
  }
  if (event.type === 'guest_join') return `${who} 进来了`;
  if (event.type === 'hint_used') return `${who} 请求了提示${doll}`;
  if (event.type === 'finale_reached' || event.type === 'session_complete') return `${who} ${label}`;
  return `${who} ${label}${doll}`;
}

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError) return reason.message;
  return reason instanceof Error ? reason.message : '读取看板失败';
}

function Stat({ label, value }: { label: string; value: number | string }): JSX.Element {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/**
 * Live host board (FR-11). SSE nudges an immediate re-fetch; a 5s poll keeps
 * working when the stream is unavailable, and the header shows which mode is
 * active so the host knows the numbers are still fresh.
 */
export function Board({ roomId, status }: { roomId: string; status: RoomStatus }): JSX.Element {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [rescueGuest, setRescueGuest] = useState('');
  const [rescueDoll, setRescueDoll] = useState('');
  const [rescueAction, setRescueAction] = useState<'discover' | 'unlock'>('unlock');
  const [rescueBusy, setRescueBusy] = useState(false);
  const [rescueNotice, setRescueNotice] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const { board } = await hostApi.board(roomId);
      setSnapshot(board);
      setError('');
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [roomId]);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), 5000);

    const source = new EventSource(`/api/board/${roomId}/stream`);
    source.addEventListener('ready', () => {
      setLive(true);
    });
    source.addEventListener('progress', () => void load());
    source.addEventListener('guest_online', () => void load());
    source.addEventListener('finale', () => void load());
    source.addEventListener('closed', () => {
      setLive(false);
      source.close();
      void load();
    });
    source.onerror = () => setLive(false);

    return () => {
      window.clearInterval(poll);
      source.close();
    };
  }, [roomId, load]);

  async function rescue(): Promise<void> {
    if (!snapshot || snapshot.guests.length === 0 || snapshot.dolls.length === 0) return;
    const guestId = rescueGuest || snapshot.guests[0]!.guest_id;
    const dollId = rescueDoll || snapshot.dolls[0]!.doll_id;
    setRescueBusy(true);
    setRescueNotice('');
    try {
      await hostApi.unlockGuest(roomId, guestId, dollId, rescueAction);
      setRescueNotice(
        rescueAction === 'unlock' ? '已直接打开这张卡的彩蛋' : '已标记为已发现',
      );
      await load();
    } catch (reason) {
      setRescueNotice(messageOf(reason));
    } finally {
      setRescueBusy(false);
    }
  }

  const totals = snapshot?.totals;

  return (
    <section className="panel board">
      <div className="panel-head">
        <h2>现场看板</h2>
        <div className="row">
          <span className={`live-badge ${live ? 'on' : 'off'}`}>
            {live ? '实时' : '离线 · 5 秒轮询'}
          </span>
          <a className="button ghost" href="/api/host/logs/export">
            导出埋点
          </a>
        </div>
      </div>

      {error ? <p className="err">{error}</p> : null}
      {!snapshot ? (
        <p className="muted">正在读取看板…</p>
      ) : (
        <>
          {status === 'draft' ? (
            <p className="muted">还没开局；客人进来后这里会实时出现进度。</p>
          ) : null}

          <div className="stats">
            <Stat label="在线" value={`${totals!.online}/${totals!.guests}`} />
            <Stat label="发现卡片" value={totals!.discovered} />
            <Stat label="已收藏" value={totals!.collected} />
            <Stat label="彩蛋解锁" value={totals!.eggs} />
            <Stat label="达成终局" value={totals!.finale} />
            <Stat label="答错次数" value={totals!.wrong_attempts} />
            <Stat label="提示请求" value={totals!.hint_requests} />
          </div>

          <h3>客人</h3>
          {snapshot.guests.length === 0 ? (
            <p className="muted">还没有客人进来。</p>
          ) : (
            <div className="board-table" role="table" aria-label="客人进度">
              <div className="board-row head" role="row">
                <span>客人</span>
                <span>状态</span>
                <span>进度（按卡片顺序）</span>
                <span>最后活跃</span>
              </div>
              {snapshot.guests.map((guest) => (
                <div className="board-row" role="row" key={guest.guest_id}>
                  <span>
                    <strong>{guest.nickname}</strong>
                    {guest.finale_reached_at ? <em className="tag gold">终局</em> : null}
                  </span>
                  <span className={guest.online ? 'online' : 'muted'}>
                    {guest.online ? '在线' : '离开'}
                  </span>
                  <span className="chips">
                    {guest.progress.map((item, index) => (
                      <i
                        key={item.doll_id}
                        className={`chip ${item.state}`}
                        title={`第 ${index + 1} 张：${STATE_LABEL[item.state]}${
                          item.attempts > 0 ? ` · 答错 ${item.attempts} 次` : ''
                        }`}
                      >
                        {index + 1}
                      </i>
                    ))}
                  </span>
                  <span className="muted mono">{clock(guest.last_seen_at)}</span>
                </div>
              ))}
            </div>
          )}

          <h3>卡片错误统计</h3>
          <div className="board-table dolls" role="table" aria-label="卡片统计">
            <div className="board-row head" role="row">
              <span>卡片</span>
              <span>发现</span>
              <span>收藏</span>
              <span>答题</span>
              <span>答错</span>
              <span>提示</span>
            </div>
            {snapshot.dolls.map((doll) => (
              <div className="board-row" role="row" key={doll.doll_id}>
                <span>
                  {doll.name} <code>{doll.short_code}</code>
                </span>
                <span>{doll.discovered}</span>
                <span>{doll.collected}</span>
                <span>
                  {doll.egg_started}
                  {doll.egg_unlocked > 0 ? ` / 解开 ${doll.egg_unlocked}` : ''}
                </span>
                <span className={doll.wrong_attempts > 0 ? 'warn' : 'muted'}>
                  {doll.wrong_attempts}
                  {doll.guests_wrong > 0 ? `（${doll.guests_wrong} 人）` : ''}
                </span>
                <span className={doll.hint_requests > 0 ? 'warn' : 'muted'}>
                  {doll.hint_requests}
                  {doll.hint_guests > 0 ? `（${doll.hint_guests} 人）` : ''}
                </span>
              </div>
            ))}
          </div>

          <h3>最近一小时</h3>
          <div className="timeline">
            {(() => {
              const max = Math.max(
                1,
                ...snapshot.timeline.map(
                  (bucket) => bucket.scanned + bucket.collected + bucket.eggs + bucket.finale,
                ),
              );
              return (
                <div className="timeline-bars">
                  {snapshot.timeline.map((bucket, index) => {
                    const segments = [
                      { key: 'scanned', value: bucket.scanned },
                      { key: 'collected', value: bucket.collected },
                      { key: 'eggs', value: bucket.eggs },
                      { key: 'finale', value: bucket.finale },
                    ];
                    const total = segments.reduce((sum, item) => sum + item.value, 0);
                    return (
                      <div
                        className="timeline-col"
                        key={bucket.start}
                        title={`${bucket.label} · 扫卡 ${bucket.scanned} · 收藏 ${bucket.collected} · 彩蛋 ${bucket.eggs} · 终局 ${bucket.finale}`}
                      >
                        <div
                          className="timeline-bar"
                          style={{
                            height: `${Math.max(total > 0 ? 6 : 0, Math.round((total / max) * 72))}px`,
                          }}
                        >
                          {segments.map((segment) => (
                            <i
                              key={segment.key}
                              className={`seg ${segment.key}`}
                              style={{ flexGrow: segment.value }}
                            />
                          ))}
                        </div>
                        <span>{index % 3 === 0 ? bucket.label : ''}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            <p className="muted small">
              每 5 分钟一格：<i className="dot scanned" /> 扫卡
              <i className="dot collected" /> 收藏
              <i className="dot eggs" /> 彩蛋
              <i className="dot finale" /> 终局
            </p>
          </div>

          <h3>最近动态</h3>
          {snapshot.recent_events.length === 0 ? (
            <p className="muted">还没有事件。</p>
          ) : (
            <ol className="feed">
              {snapshot.recent_events.map((event) => (
                <li key={event.seq}>
                  <span className="mono muted">{clock(event.at)}</span>
                  <span>{eventText(event)}</span>
                </li>
              ))}
            </ol>
          )}

          {snapshot.guests.length > 0 && snapshot.dolls.length > 0 ? (
            <details className="rescue">
              <summary>应急处理（卡片丢失 / 卡在彩蛋）</summary>
              <div className="rescue-form">
                <label>
                  客人
                  <select
                    value={rescueGuest || snapshot.guests[0]!.guest_id}
                    onChange={(event) => setRescueGuest(event.target.value)}
                  >
                    {snapshot.guests.map((guest) => (
                      <option key={guest.guest_id} value={guest.guest_id}>
                        {guest.nickname}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  卡片
                  <select
                    value={rescueDoll || snapshot.dolls[0]!.doll_id}
                    onChange={(event) => setRescueDoll(event.target.value)}
                  >
                    {snapshot.dolls.map((doll) => (
                      <option key={doll.doll_id} value={doll.doll_id}>
                        {doll.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  动作
                  <select
                    value={rescueAction}
                    onChange={(event) =>
                      setRescueAction(event.target.value as 'discover' | 'unlock')
                    }
                  >
                    <option value="unlock">直接打开彩蛋</option>
                    <option value="discover">只标记已发现</option>
                  </select>
                </label>
                <button type="button" disabled={rescueBusy} onClick={() => void rescue()}>
                  {rescueBusy ? '处理中…' : '执行'}
                </button>
              </div>
              {rescueNotice ? <p className="notice">{rescueNotice}</p> : null}
              <p className="muted small">
                卡片丢了：选「只标记已发现」，客人不用再扫码也能继续；彩蛋题太难：选「直接打开彩蛋」。
              </p>
            </details>
          ) : null}

          <p className="muted small">
            看板只显示计数与状态，不展示答案与照片；刷新页面不会丢数据，断线会自动重连。
          </p>
        </>
      )}
    </section>
  );
}

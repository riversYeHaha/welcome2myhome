import { useState } from 'react';
import type { HostRoom, SelfCheckResult } from '@shared/host';
import { ApiError, hostApi } from './api';

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError) return reason.message;
  return reason instanceof Error ? reason.message : '操作失败';
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Host operations (FR-01 self check, FR-13 backup/export + one-click clear).
 * Local-only and host-authenticated; clearing requires typing 清空.
 */
export function OpsPanel({
  room,
  onCleared,
}: {
  room: HostRoom;
  onCleared: () => Promise<void>;
}): JSX.Element {
  const [check, setCheck] = useState<SelfCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmText, setConfirmText] = useState('');

  async function runCheck(): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setCheck(await hostApi.selfCheck());
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function clearAll(): Promise<void> {
    if (confirmText.trim() !== '清空') {
      setError('请输入「清空」两个字再执行');
      return;
    }
    if (
      !window.confirm(
        '确定清空所有客人的进度、照片、模型与埋点？\n房间与人偶的文字配置会保留，此操作不可恢复。',
      )
    ) {
      return;
    }

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { cleared } = await hostApi.clearData(room.room_id, confirmText.trim());
      setConfirmText('');
      setNotice(
        `已清空：${cleared.guests} 位客人、${cleared.progress} 条进度、${cleared.events} 条埋点、${cleared.files} 个文件`,
      );
      await onCleared();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  const failed = check?.checks.filter((item) => !item.ok) ?? [];

  return (
    <section className="panel ops">
      <div className="panel-head">
        <h2>自检与数据</h2>
        <button type="button" className="ghost" disabled={busy} onClick={() => void runCheck()}>
          {busy ? '检查中…' : '运行自检'}
        </button>
      </div>

      {error ? <p className="err">{error}</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}

      {check ? (
        <>
          <p className="muted small">
            Node {check.server.node} · 运行 {Math.floor(check.server.uptime_sec / 60)} 分钟 · 数据库{' '}
            {bytes(check.data.db_bytes)} · 照片 {bytes(check.data.photos_bytes)} · 模型{' '}
            {bytes(check.data.models_bytes)}
          </p>

          <ul className="check-list">
            {check.checks.map((item) => (
              <li key={item.id} className={item.ok ? 'ok' : 'bad'}>
                <span className="mark">{item.ok ? '✓' : '!'}</span>
                <span>
                  {item.label}
                  {item.hint ? <em className="hint">{item.hint}</em> : null}
                </span>
              </li>
            ))}
          </ul>

          {check.network.urls.length > 0 ? (
            <div className="urls">
              {check.network.urls.map((item) => (
                <p key={item.url}>
                  <span className="muted">{item.label}：</span>
                  <code>{item.url}</code>
                </p>
              ))}
            </div>
          ) : null}
          <p className="muted small">{check.network.hint}</p>
          {failed.length > 0 ? (
            <p className="warn small">有 {failed.length} 项需要处理，详见上面的提示。</p>
          ) : (
            <p className="ok small">全部检查通过，可以开局。</p>
          )}
        </>
      ) : (
        <p className="muted">
          自检会检查局域网地址、人偶/彩蛋题配置、模型文件与磁盘写入权限；开局前建议跑一次。
        </p>
      )}

      <h3>备份与导出</h3>
      <div className="row">
        <a className="button ghost" href="/api/host/backup/db">
          下载数据库备份
        </a>
        <a className="button ghost" href="/api/host/backup/config">
          导出配置 JSON
        </a>
      </div>
      <p className="muted small">
        备份是 SQLite 快照（保留最近 5 份），恢复时先停服务再替换 data/home.db。配置 JSON
        含人偶与终局设置，不含 PIN、答案哈希与卡片 token。
      </p>

      <h3 className="danger-title">清空客人数据</h3>
      <p className="muted small">
        删除所有客人的进度、照片、模型与埋点，保留房间和人偶的文字配置，并把房间重置为未开局。
        不可恢复。
      </p>
      <div className="row">
        <input
          className="confirm-input"
          value={confirmText}
          onChange={(event) => setConfirmText(event.target.value)}
          placeholder="输入「清空」确认"
          maxLength={8}
        />
        <button
          type="button"
          className="danger"
          disabled={busy || confirmText.trim() !== '清空'}
          onClick={() => void clearAll()}
        >
          清空全部客人数据
        </button>
      </div>
    </section>
  );
}

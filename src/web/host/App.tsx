import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { HostRoom, HostRoomDetail } from '@shared/host';
import type { RoomStatus } from '@shared/contracts';
import { ApiError, hostApi, setCsrfToken, type HostStatus } from './api';
import { Board } from './Board';
import { DollEditor } from './DollEditor';
import { FinaleEditor } from './FinaleEditor';
import { OpsPanel } from './OpsPanel';

const STATUS_LABEL: Record<RoomStatus, string> = {
  draft: '未开局',
  live: '进行中',
  paused: '已暂停',
  ended: '已结束',
};

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError) return reason.message;
  return reason instanceof Error ? reason.message : '操作失败';
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [detail, setDetail] = useState<HostRoomDetail | null>(null);
  const [pin, setPin] = useState('');
  const [roomTitle, setRoomTitle] = useState('欢迎来到我的家');
  const [newDollName, setNewDollName] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadRoom = useCallback(async (roomId: string): Promise<void> => {
    const next = await hostApi.room(roomId);
    setDetail(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await hostApi.status();
        if (cancelled) return;
        setStatus(next);
        if (next.csrfToken) setCsrfToken(next.csrfToken);
        if (next.authenticated && next.room) await loadRoom(next.room.room_id);
      } catch (reason) {
        if (!cancelled) setError(messageOf(reason));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadRoom]);

  async function authenticate(mode: 'setup' | 'login'): Promise<void> {
    if (!/^\d{4,8}$/.test(pin)) {
      setError('PIN 必须是 4–8 位数字');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result =
        mode === 'setup'
          ? await hostApi.setup(pin, roomTitle.trim() || '欢迎来到我的家')
          : await hostApi.login(pin);
      setCsrfToken(result.csrfToken);
      setStatus({
        initialized: true,
        authenticated: true,
        room: result.room,
        csrfToken: result.csrfToken,
      });
      setPin('');
      await loadRoom(result.room.room_id);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  const refreshRoom = useCallback(async (): Promise<void> => {
    const roomId = detail?.room.room_id ?? status?.room?.room_id;
    if (roomId) await loadRoom(roomId);
  }, [detail?.room.room_id, status?.room?.room_id, loadRoom]);

  async function act(task: () => Promise<unknown>, success?: string): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
      if (success) setNotice(success);
      await refreshRoom();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createDoll(): Promise<void> {
    const name = newDollName.trim();
    if (!name) {
      setError('先填写新成员的名字');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const created = await hostApi.createDoll({ name });
      setNewDollName('');
      await refreshRoom();
      setEditingId(created.doll.doll_id);
      setNotice('人偶已创建，继续配置关卡与彩蛋题');
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function uploadDoll(): Promise<void> {
    const name = newDollName.trim();
    if (!name) {
      setError('先填写新成员的名字');
      return;
    }
    if (!photoFile) {
      setError('先选择一张照片');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const result = await hostApi.uploadDoll(name, photoFile);
      setNewDollName('');
      setPhotoFile(null);
      await refreshRoom();
      setEditingId(result.doll.doll_id);
      setNotice('照片已处理；请上传 GLB 模型，或配置 Lux3D 后重试');
      void pollTask(result.task.task_id);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function pollTask(taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const { task } = await hostApi.genTask(taskId);

        if (task.status === 'done' || task.status === 'failed') {
          await refreshRoom();
          setNotice(
            task.status === 'done'
              ? '生成完成'
              : `生成失败：${task.error ?? '请稍后重试'}`,
          );
          return;
        }

        if (task.stage === 'awaiting_upload') {
          setNotice(
            task.error
              ? task.error
              : '照片已处理；请上传 GLB 模型，或配置 Lux3D 后重试',
          );
          return;
        }

        setNotice(`生成中：${task.stage} ${task.percent}%`);
      } catch {
        return;
      }
    }
    setNotice('生成可能仍在进行，稍后刷新页面查看');
  }

  async function uploadModel(dollId: string, file: File): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await hostApi.uploadModel(dollId, file);
      await refreshRoom();
      setNotice('GLB 模型已上传，3D 展柜立即可用');
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removeDoll(dollId: string, name: string): Promise<void> {
    if (!window.confirm(`确定删除「${name}」？该卡二维码与进度会一并删除。`)) return;
    await act(() => hostApi.deleteDoll(dollId), '人偶已删除');
    setEditingId(null);
  }

  async function logout(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await hostApi.logout();
      setStatus({ initialized: true, authenticated: false, room: status?.room ?? null });
      setDetail(null);
      setNotice('');
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveNetwork(lanIp: string, port: number): Promise<void> {
    if (!detail) return;
    await hostApi.setNetwork(detail.room.room_id, lanIp, port);
    await refreshRoom();
    setNotice('局域网地址已保存，建议重新导出卡片');
  }

  if (!status) {
    return (
      <main className="host">
        <p className="muted">正在加载主人端…</p>
        {error ? <p className="err">{error}</p> : null}
      </main>
    );
  }

  if (!status.initialized || !status.authenticated) {
    const setup = !status.initialized;
    return (
      <main className="host auth">
        <header className="host-header">
          <p className="eyebrow">{setup ? '首次运行' : '主人端'}</p>
          <h1>{setup ? '先设置 PIN 和房间' : '欢迎回来'}</h1>
          <p className="sub">
            {setup
              ? 'PIN 用于保护管理端，只在主人电脑的 localhost 输入。'
              : '输入 PIN 继续布置今晚的寻宝。'}
          </p>
        </header>

        <section className="panel auth-panel">
          {setup ? (
            <label>
              房间标题
              <input
                value={roomTitle}
                onChange={(event) => setRoomTitle(event.target.value)}
                maxLength={60}
              />
            </label>
          ) : null}
          <label>
            PIN（4–8 位数字）
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              maxLength={8}
              autoComplete="current-password"
            />
          </label>
          {error ? <p className="err">{error}</p> : null}
          <button type="button" disabled={busy} onClick={() => void authenticate(setup ? 'setup' : 'login')}>
            {busy ? '请稍候…' : setup ? '创建房间并进入' : '登录'}
          </button>
          {setup ? (
            <p className="muted">首次进入会创建 6 位房间码；之后用 PIN 登录。</p>
          ) : null}
        </section>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="host">
        <p className="muted">正在读取房间…</p>
        {error ? <p className="err">{error}</p> : null}
      </main>
    );
  }

  const room = detail.room;
  const editing = detail.dolls.find((doll) => doll.doll_id === editingId) ?? null;
  const canLive = room.status === 'draft' || room.status === 'paused';

  return (
    <main className="host">
      <header className="host-header">
        <div>
          <p className="eyebrow">主人端</p>
          <h1>{room.title}</h1>
          <p className="sub">
            房间码 <code>{room.room_code}</code> ·{' '}
            <span className={`pill ${room.status}`}>{STATUS_LABEL[room.status]}</span>
          </p>
        </div>
        <button type="button" className="ghost" disabled={busy} onClick={() => void logout()}>
          退出
        </button>
      </header>

      {error ? <p className="err banner">{error}</p> : null}
      {notice ? <p className="notice banner">{notice}</p> : null}

      <section className="panel">
        <div className="panel-head">
          <h2>房间</h2>
          <div className="row">
            <a
              className="button ghost"
              href="/api/cards/print"
              target="_blank"
              rel="noreferrer"
            >
              打印卡片
            </a>
            <a className="button ghost" href="/api/cards/pdf">
              下载 PDF
            </a>
            {canLive ? (
              <button type="button" disabled={busy} onClick={() => void act(() => hostApi.setStatus(room.room_id, 'live'), '已开局')}>
                开局 / 继续
              </button>
            ) : null}
            {room.status === 'live' ? (
              <button type="button" className="ghost" disabled={busy} onClick={() => void act(() => hostApi.setStatus(room.room_id, 'paused'), '已暂停')}>
                暂停
              </button>
            ) : null}
            {room.status === 'live' || room.status === 'paused' ? (
              <button type="button" className="danger" disabled={busy} onClick={() => void act(() => hostApi.setStatus(room.room_id, 'ended'), '已结束')}>
                结束
              </button>
            ) : null}
          </div>
        </div>

        <div className="room-grid">
          <div>
            <h3>欢迎码</h3>
            <img className="qr" src="/api/cards/welcome.png" alt="欢迎码" />
            <p className="muted">贴在门口或餐桌；客人扫码进入。</p>
          </div>
          <NetworkForm room={room} onSave={saveNetwork} />
        </div>
      </section>

      <Board roomId={room.room_id} status={room.status} />

      <section className="panel">
        <div className="panel-head">
          <h2>人偶（{detail.dolls.length}）</h2>
          <div className="create-doll">
            <input
              value={newDollName}
              onChange={(event) => setNewDollName(event.target.value)}
              placeholder="新成员名字"
              maxLength={30}
            />
            <input
              className="file"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => setPhotoFile(event.target.files?.[0] ?? null)}
              aria-label="上传照片"
            />
            <button type="button" disabled={busy} onClick={() => void createDoll()}>
              仅创建
            </button>
            <button
              type="button"
              disabled={busy || !photoFile}
              onClick={() => void uploadDoll()}
            >
              上传照片生成
            </button>
          </div>
        </div>

        {detail.dolls.length === 0 ? (
          <p className="muted">还没有人偶。先添加一个，再配置关卡与彩蛋题。</p>
        ) : (
          <div className="doll-grid">
            {detail.dolls.map((doll) => (
              <article className="doll-card" key={doll.doll_id}>
                <div className="panel-head">
                  <strong>{doll.name}</strong>
                  <span className="code">{doll.short_code}</span>
                </div>
                <p className="muted">
                  {doll.level_type === 'discovery' ? '纯发现' : '彩蛋题'}
                  {doll.egg_enabled ? ' · E2 已开' : ''}
                  {doll.answer_configured ? '' : ' · 答案未配置'}
                  {' · '}
                  {doll.gen_status === 'done'
                    ? '模型已就绪'
                    : doll.gen_status === 'queued'
                      ? '等待 GLB'
                      : `生成${doll.gen_status}`}
                </p>
                <img
                  className="qr"
                  src={`/api/cards/${doll.doll_id}/qr.png`}
                  alt={`${doll.name} 二维码`}
                  loading="lazy"
                />
                <div className="row">
                  <button type="button" onClick={() => setEditingId(doll.doll_id)}>
                    编辑
                  </button>
                  <a
                    className="button ghost"
                    href={`/d/${doll.card_token}?preview=1`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    预览
                  </a>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void removeDoll(doll.doll_id, doll.name)}
                  >
                    删除
                  </button>
                  <label className="upload">
                    上传 GLB
                    <input
                      type="file"
                      accept=".glb,model/gltf-binary"
                      disabled={busy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file) void uploadModel(doll.doll_id, file);
                      }}
                    />
                  </label>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <OpsPanel
        room={room}
        onCleared={async () => {
          await refreshRoom();
        }}
      />

      {editing ? (
        <DollEditor
          doll={editing}
          onSaved={(saved) => {
            setEditingId(saved.doll_id);
            void refreshRoom();
            setNotice('关卡已保存');
          }}
          onClose={() => setEditingId(null)}
        />
      ) : null}

      <FinaleEditor
        room={room}
        onSaved={async () => {
          await refreshRoom();
          setNotice('终局已保存');
        }}
      />
    </main>
  );
}

function NetworkForm({
  room,
  onSave,
}: {
  room: HostRoom;
  onSave: (ip: string, port: number) => Promise<void>;
}): JSX.Element {
  const [lanIp, setLanIp] = useState(room.lan_ip);
  const [port, setPort] = useState(String(room.port || 8080));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLanIp(room.lan_ip);
    setPort(String(room.port || 8080));
  }, [room.lan_ip, room.port]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave(lanIp.trim(), Number(port) || 8080);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="network" onSubmit={(event) => void submit(event)}>
      <h3>局域网地址</h3>
      <label>
        LAN IP
        <input
          value={lanIp}
          onChange={(event) => setLanIp(event.target.value)}
          placeholder="192.168.1.50"
          inputMode="decimal"
        />
      </label>
      <label>
        端口
        <input
          value={port}
          onChange={(event) => setPort(event.target.value)}
          inputMode="numeric"
          maxLength={5}
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? '保存中…' : '保存地址'}
      </button>
      <p className="muted">卡片二维码会写入这个地址；IP 变化后需要重新导出。</p>
      {error ? <p className="err">{error}</p> : null}
    </form>
  );
}

import { useEffect, useState } from 'react';
import type { HealthResponse } from '@shared/contracts';

export function App(): JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/health', { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as HealthResponse;
        if (!cancelled) setHealth(body);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="host">
      <header className="host-header">
        <p className="eyebrow">S0 · 主人端占位</p>
        <h1>欢迎来到我的家 · 主人端</h1>
        <p className="sub">登录、房间、人偶与关卡配置将在 T201 / T901 接入。</p>
      </header>

      <section className="panel" aria-live="polite">
        <h2>服务状态</h2>
        {health ? (
          <dl>
            <div>
              <dt>服务</dt>
              <dd className="ok">已连接</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>v{health.version}</dd>
            </div>
            <div>
              <dt>数据库 schema</dt>
              <dd>v{health.db.schemaVersion ?? '?'}</dd>
            </div>
            <div>
              <dt>启动时长</dt>
              <dd>{health.uptimeSec}s</dd>
            </div>
          </dl>
        ) : error ? (
          <p className="err">无法连接服务：{error}</p>
        ) : (
          <p className="muted">正在检查…</p>
        )}
      </section>

      <section className="panel">
        <h2>下一步（S0 → S2）</h2>
        <ol className="todo">
          <li>T104 数据访问层（room / doll / guest / progress）</li>
          <li>T201/T202 主人 PIN 与房间创建</li>
          <li>T301/T302 token、短码与二维码</li>
          <li>T401/T402 E1 全量响应与 SSR 卡片页</li>
        </ol>
      </section>

      <footer className="host-foot">
        <a href="/">← 客人端</a>
        <span>welcome2myhome · v0.1.0</span>
      </footer>
    </main>
  );
}

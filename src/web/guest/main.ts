import type { HealthResponse } from '@shared/contracts';
import './style.css';

const statusEl = document.querySelector<HTMLDivElement>('#status');
const statusTextEl = document.querySelector<HTMLSpanElement>('#status-text');

function setStatus(state: 'loading' | 'ok' | 'error', text: string): void {
  if (statusEl) statusEl.dataset.state = state;
  if (statusTextEl) statusTextEl.textContent = text;
}

async function checkHealth(): Promise<void> {
  setStatus('loading', '正在连接主人家的服务…');

  try {
    const response = await fetch('/api/health', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const health = (await response.json()) as HealthResponse;
    if (!health.ok) throw new Error('数据库未就绪');

    setStatus(
      'ok',
      `服务已连接 · v${health.version} · 数据库 schema v${health.db.schemaVersion ?? '?'}`,
    );
  } catch (error) {
    setStatus('error', '连接失败：请确认已连接主人家 WiFi，并且主人电脑上的服务已启动。');
    console.warn('[guest] health check failed', error);
  }
}

void checkHealth();

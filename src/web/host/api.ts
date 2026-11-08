import type { BoardSnapshot } from '@shared/board';
import type { FinaleConfig } from '@shared/finale';
import type { ClearSummary, HostDoll, HostRoom, HostRoomDetail, SelfCheckResult } from '@shared/host';
import type { LevelType } from '@shared/levels';

export interface HostStatus {
  initialized: boolean;
  authenticated: boolean;
  room: HostRoom | null;
  csrfToken?: string;
}

export interface AuthResponse {
  room: HostRoom;
  csrfToken: string;
}

export interface DollResponse {
  doll: HostDoll;
}

export interface FinaleResponse {
  finale: FinaleConfig;
  warning?: string;
}

export interface GenTask {
  task_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  stage: string;
  percent: number;
  error: string | null;
  fallback_used: boolean;
  provider: string;
}

export interface UploadDollResponse {
  doll: HostDoll;
  task: GenTask;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken = '';

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

async function readResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error?.code ?? 'HTTP_ERROR',
      data?.error?.message ?? `请求失败（${response.status}）`,
    );
  }
  return data as T;
}

async function requestMultipart<T>(path: string, form: FormData): Promise<T> {
  const headers = new Headers();
  headers.set('accept', 'application/json');
  if (csrfToken) headers.set('x-wtm-csrf', csrfToken);

  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: form,
  });
  return readResponse<T>(response);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body) headers.set('content-type', 'application/json');
  if (method !== 'GET' && csrfToken) headers.set('x-wtm-csrf', csrfToken);

  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers,
  });

  return readResponse<T>(response);
}

export const hostApi = {
  status: () => request<HostStatus>('/api/host/status'),
  setup: (pin: string, title: string) =>
    request<AuthResponse>('/api/host/setup', {
      method: 'POST',
      body: JSON.stringify({ pin, title }),
    }),
  login: (pin: string) =>
    request<AuthResponse>('/api/host/login', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    }),
  logout: () => request<void>('/api/host/logout', { method: 'POST' }),
  me: () => request<AuthResponse>('/api/host/me'),
  room: (roomId: string) => request<HostRoomDetail>(`/api/room/${roomId}`),
  board: (roomId: string) =>
    request<{ board: BoardSnapshot }>(`/api/board/${roomId}`),
  createDoll: (body: {
    name: string;
    tagline?: string;
    levelType?: 'discovery' | 'bonus_quiz';
  }) => request<DollResponse>('/api/dolls', { method: 'POST', body: JSON.stringify(body) }),
  updateDoll: (dollId: string, body: Record<string, unknown>) =>
    request<DollResponse>(`/api/dolls/${dollId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  updateLevel: (dollId: string, body: unknown) =>
    request<DollResponse>(`/api/dolls/${dollId}/level`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  uploadDoll: (name: string, photo: File) => {
    const form = new FormData();
    form.append('name', name);
    form.append('photo', photo);
    return requestMultipart<UploadDollResponse>('/api/dolls/upload', form);
  },
  uploadModel: (dollId: string, model: File) => {
    const form = new FormData();
    form.append('model', model);
    return requestMultipart<{ doll: HostDoll }>(`/api/dolls/${dollId}/asset`, form);
  },
  genTask: (taskId: string) => request<{ task: GenTask }>(`/api/gen/${taskId}`),
  deleteDoll: (dollId: string) =>
    request<void>(`/api/dolls/${dollId}`, { method: 'DELETE' }),
  setStatus: (roomId: string, status: 'live' | 'paused' | 'ended') =>
    request<{ room: HostRoom }>(`/api/room/${roomId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  setNetwork: (roomId: string, lanIp: string, port: number) =>
    request<{ room: HostRoom }>(`/api/room/${roomId}/network`, {
      method: 'PATCH',
      body: JSON.stringify({ lan_ip: lanIp, port }),
    }),
  updateFinale: (roomId: string, body: Record<string, unknown>) =>
    request<FinaleResponse>(`/api/room/${roomId}/finale`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  openFinale: (roomId: string) =>
    request<FinaleResponse>(`/api/room/${roomId}/finale/open`, { method: 'POST' }),
  selfCheck: () => request<SelfCheckResult>('/api/host/selfcheck'),
  clearData: (roomId: string, confirm: string) =>
    request<{ cleared: ClearSummary }>(`/api/room/${roomId}/data`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm }),
    }),
  unlockGuest: (roomId: string, guestId: string, dollId: string, action: 'discover' | 'unlock') =>
    request<{ state: string }>(`/api/room/${roomId}/guests/${guestId}/unlock`, {
      method: 'POST',
      body: JSON.stringify({ doll_id: dollId, action }),
    }),
};

/** P2 types are shown but disabled in the editor. */
export const P0_LEVEL_TYPES: Array<{ value: LevelType; label: string }> = [
  { value: 'discovery', label: '纯发现（只有 E1）' },
  { value: 'bonus_quiz', label: '发现 + 彩蛋题（默认）' },
];

export const P2_LEVEL_TYPES: Array<{ value: LevelType; label: string }> = [
  { value: 'clue_chain', label: '线索链（即将上线）' },
  { value: 'duo_scan', label: '双人扫码（即将上线）' },
  { value: 'timed', label: '限时挑战（即将上线）' },
];

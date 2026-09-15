import { User, UserStatus } from '../types';
import { API_URL } from './config';
import { getLocalSession } from './auth';

export interface AccountInfo {
  email: string;
  username: string;
  tag: string;
  createdAt: number;
  otherSessions: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const { token } = getLocalSession();
  if (!token) return { ok: false, error: 'Sessão expirada. Entre novamente.' };

  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
    });
    if (res.status === 413) {
      return { ok: false, error: 'A imagem é grande demais (máximo de 2 MB).' };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, error: body?.error || `O servidor respondeu com erro ${res.status}.` };
    }
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, error: 'Não foi possível conectar ao servidor.' };
  }
}

const jsonBody = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

export const apiUpdateProfile = (displayName: string) =>
  request<{ user: User }>('/api/users/me/profile', jsonBody('PATCH', { displayName }));

export const apiUpdatePresence = (status: UserStatus, customStatus: string) =>
  request<{ user: User }>('/api/users/me/presence', jsonBody('PATCH', { status, customStatus }));

export const apiUploadAvatar = (file: File) =>
  request<{ user: User }>('/api/users/me/avatar', {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });

export const apiGetAccount = () => request<AccountInfo>('/api/users/me/account');

export const apiChangePassword = (currentPassword: string, newPassword: string) =>
  request<{ revokedSessions: number }>(
    '/api/users/me/password',
    jsonBody('POST', { currentPassword, newPassword })
  );

export const apiRevokeOtherSessions = () =>
  request<{ revokedSessions: number }>('/api/users/me/sessions/revoke-others', { method: 'POST' });

/** Convidados não têm conta, perfil editável nem avatar próprio */
export const isGuestUser = (user: User) => user.role === 'Visitante';

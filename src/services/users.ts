import { User, UserStatus } from '../types';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, jsonBody, request } from './api';

export interface AccountInfo {
  email: string;
  username: string;
  tag: string;
  createdAt: number;
  otherSessions: number;
}

export type { ApiResult } from './api';

export const MAX_AVATAR_BYTES = MAX_IMAGE_BYTES;
export const AVATAR_TYPES = IMAGE_TYPES;

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

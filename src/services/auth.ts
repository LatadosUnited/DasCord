import { User } from '../types';
import { API_URL } from './config';

const API_BASE = `${API_URL}/api/auth`;

export interface RegisterPayload {
  email: string;
  username: string;
  displayName?: string;
  password: string;
}

export interface LoginPayload {
  login: string;
  password: string;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  user?: User;
  error?: string;
}

export async function apiRegister(payload: RegisterPayload): Promise<AuthResponse> {
  try {
    const res = await fetch(`${API_BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    return data;
  } catch (err) {
    return {
      success: false,
      error: 'Não foi possível conectar ao servidor Rust (porta 3001).',
    };
  }
}

export async function apiLogin(payload: LoginPayload): Promise<AuthResponse> {
  try {
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    return data;
  } catch (err) {
    return {
      success: false,
      error: 'Não foi possível conectar ao servidor Rust (porta 3001).',
    };
  }
}

export async function apiGuestLogin(): Promise<AuthResponse> {
  try {
    const res = await fetch(`${API_BASE}/guest`, { method: 'POST' });
    return await res.json();
  } catch {
    return {
      success: false,
      error: 'Não foi possível conectar ao servidor Rust (porta 3001).',
    };
  }
}

/** Invalida o token no servidor. Falhas são ignoradas: a sessão local é limpa de qualquer forma. */
export async function apiLogout(token: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // servidor offline
  }
}

export type SessionCheck =
  | { status: 'valid'; user: User }
  | { status: 'invalid' } // servidor respondeu 401: token morto
  | { status: 'unreachable' }; // erro de rede ou servidor com falha: não dá para saber

export async function apiVerifySession(token: string): Promise<SessionCheck> {
  try {
    const res = await fetch(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      return { status: 'invalid' };
    }
    if (res.ok) {
      const data = await res.json();
      return data.user ? { status: 'valid', user: data.user } : { status: 'invalid' };
    }
    return { status: 'unreachable' };
  } catch {
    return { status: 'unreachable' };
  }
}

export function saveLocalSession(token: string, user: User) {
  localStorage.setItem('dascord_token', token);
  localStorage.setItem('dascord_user', JSON.stringify(user));
}

export function getLocalSession(): { token: string | null; user: User | null } {
  const token = localStorage.getItem('dascord_token');
  const userJson = localStorage.getItem('dascord_user');
  let user: User | null = null;
  if (userJson) {
    try {
      user = JSON.parse(userJson);
    } catch {}
  }
  return { token, user };
}

export function clearLocalSession() {
  localStorage.removeItem('dascord_token');
  localStorage.removeItem('dascord_user');
}

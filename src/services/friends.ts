import { User } from '../types';
import { API_URL } from './config';

const API_BASE = `${API_URL}/api/friends`;

export interface IncomingRequest {
  request_id: string;
  from_user: User;
  created_at: number;
}

export interface OutgoingRequest {
  request_id: string;
  to_user: User;
  created_at: number;
}

export interface FriendsSummary {
  friends: User[];
  incoming_requests: IncomingRequest[];
  outgoing_requests: OutgoingRequest[];
}

export async function apiGetFriends(token: string): Promise<FriendsSummary | null> {
  try {
    const res = await fetch(API_BASE, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      return await res.json();
    }
    return null;
  } catch {
    return null;
  }
}

export async function apiSendFriendRequest(
  token: string,
  query: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });
    return await res.json();
  } catch {
    return { success: false, error: 'Falha ao conectar com o servidor Rust.' };
  }
}

export async function apiAcceptFriendRequest(
  token: string,
  requestId: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ request_id: requestId }),
    });
    return await res.json();
  } catch {
    return { success: false, error: 'Falha ao conectar com o servidor Rust.' };
  }
}

export async function apiDeclineFriendRequest(
  token: string,
  requestId: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/decline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ request_id: requestId }),
    });
    return await res.json();
  } catch {
    return { success: false, error: 'Falha ao conectar com o servidor Rust.' };
  }
}

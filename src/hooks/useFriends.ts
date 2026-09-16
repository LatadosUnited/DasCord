import { useCallback, useEffect, useState } from 'react';
import { User } from '../types';
import { FriendsSummary, apiGetFriends } from '../services/friends';
import { getLocalSession } from '../services/auth';

/** Amigos, pedidos de amizade e a conversa direta aberta */
export function useFriends(isAuthenticated: boolean) {
  const [summary, setSummary] = useState<FriendsSummary>({
    friends: [],
    incoming_requests: [],
    outgoing_requests: [],
  });
  const [activeDMUser, setActiveDMUser] = useState<User | null>(null);

  const refresh = useCallback(async () => {
    const { token } = getLocalSession();
    if (!token) return;
    const next = await apiGetFriends(token);
    if (next) setSummary(next);
  }, []);

  // Ao entrar (login novo ou sessão restaurada), busca a lista do servidor
  useEffect(() => {
    if (isAuthenticated) refresh();
  }, [isAuthenticated, refresh]);

  /** Perfil, avatar ou status mudou: reflete no amigo e na DM abertos */
  const applyUserUpdate = useCallback((updated: User) => {
    const merge = (u: User) => (u.id === updated.id ? { ...u, ...updated } : u);
    setActiveDMUser((prev) => (prev ? merge(prev) : prev));
    setSummary((prev) => ({
      friends: prev.friends.map(merge),
      incoming_requests: prev.incoming_requests.map((r) => ({ ...r, from_user: merge(r.from_user) })),
      outgoing_requests: prev.outgoing_requests.map((r) => ({ ...r, to_user: merge(r.to_user) })),
    }));
  }, []);

  const reset = useCallback(() => setActiveDMUser(null), []);

  return { summary, refresh, activeDMUser, setActiveDMUser, applyUserUpdate, reset };
}

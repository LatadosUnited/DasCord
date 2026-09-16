import { useCallback, useEffect, useRef, useState } from 'react';
import { User } from '../types';
import { realtimeSocket } from '../services/socket';
import {
  apiLogout,
  apiVerifySession,
  clearLocalSession,
  getLocalSession,
  saveLocalSession,
} from '../services/auth';

/** Só existe antes do login: a tela de autenticação cobre o app inteiro */
const SIGNED_OUT_USER: User = {
  id: '',
  name: '',
  tag: '',
  avatar: '',
  status: 'offline',
  role: '',
  roleColor: '',
};

/**
 * Quem está usando o app e por quanto tempo essa sessão vale.
 * `onSessionEnded` é chamado quando a sessão cai sozinha (token recusado): quem compõe
 * o app aproveita para limpar os outros domínios.
 */
export function useSession(onSessionEnded: () => void) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState<User>(SIGNED_OUT_USER);

  // O callback muda a cada render de quem compõe; o efeito de montagem lê sempre o atual
  const onSessionEndedRef = useRef(onSessionEnded);
  useEffect(() => {
    onSessionEndedRef.current = onSessionEnded;
  }, [onSessionEnded]);

  // Lido dentro dos listeners do WebSocket, que não enxergam o estado atual
  const currentUserIdRef = useRef('');
  useEffect(() => {
    currentUserIdRef.current = currentUser.id;
  }, [currentUser.id]);

  // Sessão salva no localStorage: entra na hora e confere com o servidor em segundo plano
  useEffect(() => {
    const { token, user } = getLocalSession();
    if (!token || !user) return;
    setCurrentUser(user);
    setIsAuthenticated(true);
    realtimeSocket.setToken(token);

    apiVerifySession(token).then((check) => {
      if (check.status === 'valid') {
        setCurrentUser(check.user);
      } else if (check.status === 'invalid') {
        // Token rejeitado (401): limpa sessão e desautentica
        onSessionEndedRef.current();
      }
      // 'unreachable': servidor offline, mantém a sessão local
    });
  }, []);

  const signIn = useCallback((user: User) => {
    setCurrentUser(user);
    setIsAuthenticated(true);
    // A tela de login já salvou o token antes de avisar
    realtimeSocket.setToken(getLocalSession().token);
  }, []);

  /** Encerra a sessão local. Não lê estado, então é seguro chamar de dentro de listeners. */
  const signOut = useCallback(() => {
    realtimeSocket.setToken(null);
    clearLocalSession();
    setIsAuthenticated(false);
  }, []);

  /** O usuário pediu para sair: avisa o servidor e encerra tudo */
  const requestLogout = useCallback(() => {
    const { token } = getLocalSession();
    if (token) apiLogout(token);
    onSessionEndedRef.current();
  }, []);

  const applyUserUpdate = useCallback((updated: User) => {
    setCurrentUser((prev) => (prev.id === updated.id ? { ...prev, ...updated } : prev));
    const { token, user } = getLocalSession();
    if (token && user?.id === updated.id) {
      saveLocalSession(token, { ...user, ...updated });
    }
  }, []);

  const getCurrentUserId = useCallback(() => currentUserIdRef.current, []);

  return {
    isAuthenticated,
    currentUser,
    signIn,
    signOut,
    requestLogout,
    applyUserUpdate,
    getCurrentUserId,
  };
}

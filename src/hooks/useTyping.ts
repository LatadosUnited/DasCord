import { useCallback, useEffect, useRef, useState } from 'react';
import { realtimeSocket } from '../services/socket';

/** Alguém digitando em um canal, com o momento do último aviso recebido */
type TypingEntry = { userId: string; name: string; at: number };
/** Sem um aviso novo nesse tempo, a pessoa parou de digitar */
const TYPING_TTL_MS = 7000;
/** Intervalo entre os avisos que enviamos enquanto o usuário digita */
const TYPING_THROTTLE_MS = 4000;

/** Quem está digitando em cada canal. O aviso não tem "parei": some sozinho pelo TTL. */
export function useTyping(currentChannelId: string) {
  const [typingByChannel, setTypingByChannel] = useState<Record<string, TypingEntry[]>>({});
  const lastTypingSentRef = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - TYPING_TTL_MS;
      setTypingByChannel((prev) => {
        let changed = false;
        const next: Record<string, TypingEntry[]> = {};
        for (const [channelId, entries] of Object.entries(prev)) {
          const kept = entries.filter((entry) => entry.at > cutoff);
          if (kept.length !== entries.length) changed = true;
          if (kept.length > 0) next[channelId] = kept;
        }
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  /** Chegou um aviso de digitação de outra pessoa */
  const remoteTyping = useCallback((channelId: string, userId: string, name: string) => {
    setTypingByChannel((prev) => {
      const others = (prev[channelId] || []).filter((entry) => entry.userId !== userId);
      return { ...prev, [channelId]: [...others, { userId, name, at: Date.now() }] };
    });
  }, []);

  /** Mandou a mensagem: parou de digitar */
  const clearFor = useCallback((channelId: string, userId: string) => {
    setTypingByChannel((prev) => {
      const entries = prev[channelId];
      if (!entries?.some((entry) => entry.userId === userId)) return prev;
      return { ...prev, [channelId]: entries.filter((entry) => entry.userId !== userId) };
    });
  }, []);

  // Um aviso a cada poucos segundos basta: no destino o indicador some sozinho
  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return;
    lastTypingSentRef.current = now;
    realtimeSocket.send({ type: 'typing', channelId: currentChannelId, data: {} });
  }, [currentChannelId]);

  const typingNames = (typingByChannel[currentChannelId] || []).map((entry) => entry.name);

  return { typingNames, notifyTyping, remoteTyping, clearFor };
}

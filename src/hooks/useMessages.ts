import { useCallback, useEffect, useRef, useState } from 'react';
import { Message, User } from '../types';
import { realtimeSocket } from '../services/socket';
import { generateLocalSnowflake } from '../services/snowflake';
import { getLocalSession } from '../services/auth';
import {
  apiGetChannelMessages,
  applyMessageUpdate,
  applyReaction,
  mergeMessages,
  removeMessage,
  withTimestamp,
} from '../services/messages';

interface Options {
  channelId: string;
  currentUser: User;
  isAuthenticated: boolean;
  serverOnline: boolean;
}

/** Histórico por canal, envio otimista e as mudanças que chegam pelo socket */
export function useMessages({ channelId, currentUser, isAuthenticated, serverOnline }: Options) {
  const [byChannel, setByChannel] = useState<Record<string, Message[]>>({});
  // Espelho do estado para ler o histórico fora do render (ex: a mensagem respondida)
  const byChannelRef = useRef(byChannel);
  useEffect(() => {
    byChannelRef.current = byChannel;
  }, [byChannel]);

  // Carrega o histórico salvo ao abrir um canal, e de novo ao reconectar (pega o que chegou offline)
  useEffect(() => {
    if (!isAuthenticated || !serverOnline || !channelId) return;
    const { token } = getLocalSession();
    if (!token) return;

    let cancelled = false;
    const target = channelId;
    apiGetChannelMessages(token, target).then((history) => {
      if (cancelled || !history) return;
      setByChannel((prev) => ({
        ...prev,
        [target]: mergeMessages(prev[target] || [], history),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [channelId, isAuthenticated, serverOnline]);

  const send = useCallback(
    async (text: string, replyToId?: string, attachmentIds?: string[]) => {
      const targetChannelId = channelId;
      // ID local provisório: o servidor devolve a mensagem oficial com este valor em "nonce"
      const localId = generateLocalSnowflake();
      const repliedTo = replyToId
        ? (byChannelRef.current[targetChannelId] || []).find((m) => m.id === replyToId)
        : undefined;

      const sent = realtimeSocket.send({
        type: 'message',
        channelId: targetChannelId,
        data: { id: localId, content: text, replyToId, attachmentIds },
      });

      const newMessage: Message = {
        id: localId,
        channelId: targetChannelId,
        author: currentUser,
        content: text,
        timestamp: sent ? 'Enviando...' : 'Não enviada (sem conexão)',
        reactions: [],
        createdAt: Date.now(),
        // Versão local da resposta; a oficial chega junto com a mensagem salva
        replyTo: repliedTo && {
          id: repliedTo.id,
          authorName: repliedTo.author.name,
          content: repliedTo.content,
          deleted: false,
        },
      };

      setByChannel((prev) => ({
        ...prev,
        [targetChannelId]: mergeMessages(prev[targetChannelId] || [], [newMessage]),
      }));

      // Invoke Rust IPC for native message registration
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('send_message_native', {
          payload: {
            id: newMessage.id,
            channel_id: newMessage.channelId,
            author_name: newMessage.author.name,
            author_avatar: newMessage.author.avatar,
            content: newMessage.content,
            timestamp: newMessage.timestamp,
          },
        });
      } catch {
        // Browser preview fallback
      }
    },
    [channelId, currentUser]
  );

  // Reagir, editar e apagar passam pelo servidor: todo mundo vê o mesmo resultado
  const toggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      realtimeSocket.send({ type: 'reaction', channelId, data: { messageId, emoji } });
    },
    [channelId]
  );

  const edit = useCallback(
    (messageId: string, content: string) => {
      realtimeSocket.send({ type: 'message-edit', channelId, data: { id: messageId, content } });
    },
    [channelId]
  );

  const remove = useCallback(
    (messageId: string) => {
      realtimeSocket.send({ type: 'message-delete', channelId, data: { id: messageId } });
    },
    [channelId]
  );

  const receive = useCallback((incomingChannelId: string, data: Message) => {
    const incoming = withTimestamp(data);
    setByChannel((prev) => ({
      ...prev,
      [incomingChannelId]: mergeMessages(prev[incomingChannelId] || [], [incoming]),
    }));
    return incoming;
  }, []);

  const applyUpdate = useCallback((incomingChannelId: string, updated: Message) => {
    setByChannel((prev) => ({
      ...prev,
      [incomingChannelId]: applyMessageUpdate(prev[incomingChannelId] || [], updated),
    }));
  }, []);

  const applyDelete = useCallback((incomingChannelId: string, messageId: string) => {
    setByChannel((prev) => ({
      ...prev,
      [incomingChannelId]: removeMessage(prev[incomingChannelId] || [], messageId),
    }));
  }, []);

  const applyReactionEvent = useCallback(
    (incomingChannelId: string, messageId: string, emoji: string, userIds: string[]) => {
      setByChannel((prev) => ({
        ...prev,
        [incomingChannelId]: applyReaction(prev[incomingChannelId] || [], messageId, emoji, userIds),
      }));
    },
    []
  );

  const reset = useCallback(() => setByChannel({}), []);

  return {
    messages: byChannel[channelId] || [],
    send,
    toggleReaction,
    edit,
    remove,
    receive,
    applyUpdate,
    applyDelete,
    applyReactionEvent,
    reset,
  };
}

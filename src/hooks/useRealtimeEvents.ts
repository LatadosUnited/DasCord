import { useEffect, useRef } from 'react';
import { Message, User } from '../types';
import { SocketEvent, realtimeSocket } from '../services/socket';
import { ServerDto } from '../services/servers';

/**
 * Cada evento do servidor entregue a quem é dono do assunto. Nada de estado mora aqui:
 * é só a tabela que liga o nome do evento ao domínio que sabe reagir.
 */
export interface RealtimeHandlers {
  /** O servidor recusou o token (ex: sessão expirou) */
  onAuthError: () => void;
  /** É o próprio usuário? Eventos sobre nós mesmos recebem tratamento diferente. */
  isSelf: (userId: string) => boolean;
  onVoiceEvent: (event: SocketEvent) => void;
  onMessage: (channelId: string, message: Message) => void;
  onMessageUpdated: (channelId: string, message: Message) => void;
  onMessageDeleted: (channelId: string, messageId: string) => void;
  onReaction: (channelId: string, messageId: string, emoji: string, userIds: string[]) => void;
  onTyping: (channelId: string, userId: string, name: string) => void;
  onUserUpdated: (user: User) => void;
  onFriendshipChanged: () => void;
  onSelfJoinedServer: () => void;
  onMemberJoined: (serverId: string, member: User) => void;
  onSelfLeftServer: (serverId: string) => void;
  onMemberLeft: (serverId: string, userId: string) => void;
  onServerUpdated: (server: ServerDto) => void;
  onServerDeleted: (serverId: string) => void;
  onChannelDeleted: (channelId: string) => void;
}

/** Assina o socket uma vez e despacha cada evento para o domínio dono dele */
export function useRealtimeEvents(handlers: RealtimeHandlers) {
  // Os handlers mudam a cada render; a assinatura fica de pé o app inteiro
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const unsubAuthError = realtimeSocket.subscribeAuthError(() => ref.current.onAuthError());

    const unsubMessages = realtimeSocket.subscribeMessages((event: SocketEvent) => {
      const h = ref.current;
      const { type, channelId, data } = event;

      if (type.startsWith('voice-') || type.startsWith('screen-')) {
        h.onVoiceEvent(event);
        return;
      }
      if (!data) return;

      switch (type) {
        case 'message':
          h.onMessage(channelId, data as Message);
          break;
        case 'message-updated':
          h.onMessageUpdated(channelId, data as Message);
          break;
        case 'message-deleted': {
          const { id } = data as { id: string };
          h.onMessageDeleted(channelId, id);
          break;
        }
        case 'reaction': {
          const { messageId, emoji, userIds } = data as {
            messageId: string;
            emoji: string;
            userIds: string[];
          };
          h.onReaction(channelId, messageId, emoji, userIds);
          break;
        }
        case 'typing': {
          const { userId, name } = data as { userId: string; name: string };
          // O aviso volta para todo o canal, inclusive para quem digitou
          if (!h.isSelf(userId)) h.onTyping(channelId, userId, name);
          break;
        }
        case 'user-updated':
          // Perfil, avatar ou status mudou (seu, em outra sessão, de um amigo ou de um membro)
          h.onUserUpdated(data as User);
          break;
        case 'friend-request-received':
        case 'friend-request-accepted':
          h.onFriendshipChanged();
          break;
        case 'server-member-joined': {
          const { serverId, member } = data as { serverId: string; member: User };
          if (h.isSelf(member.id)) {
            // Criou ou entrou em um servidor (talvez em outra sessão): busca a lista completa
            h.onSelfJoinedServer();
          } else {
            h.onMemberJoined(serverId, member);
          }
          break;
        }
        case 'server-member-left': {
          const { serverId, userId } = data as { serverId: string; userId: string };
          if (h.isSelf(userId)) {
            h.onSelfLeftServer(serverId);
          } else {
            h.onMemberLeft(serverId, userId);
          }
          break;
        }
        case 'server-updated': {
          const { server } = data as { server?: ServerDto };
          if (server) h.onServerUpdated(server);
          break;
        }
        case 'server-deleted': {
          const { serverId } = data as { serverId: string };
          h.onServerDeleted(serverId);
          break;
        }
        case 'channel-deleted': {
          // O server-updated que vem junto já tira o canal da lista;
          // aqui é a reação de quem estava nele
          const { channelId: deleted } = data as { channelId: string };
          h.onChannelDeleted(deleted);
          break;
        }
      }
    });

    return () => {
      unsubAuthError();
      unsubMessages();
    };
  }, []);
}

// O formato dos eventos de voz no WebSocket, num lugar só.
//
// Os dois motores falam o mesmo protocolo com o servidor Rust: o SFU manda
// presença e estado, e o P2P manda também a negociação das conexões. Antes cada
// um montava o payload na mão, em 17 lugares — mudar um campo pedia procurar
// todos. O servidor valida e reescreve o que identifica quem enviou
// (`handle_client_event`, em server/src/ws.rs): o que vai daqui é o pedido.
import { realtimeSocket } from './socket';
import { User } from '../types';

/** Como os outros nos veem ao entrar no canal e enquanto estamos nele */
export interface VoicePresence {
  muted: boolean;
  deafened: boolean;
  streaming: boolean;
}

/** Entrou no canal de voz */
export function sendJoin(channelId: string, user: User, presence: VoicePresence) {
  realtimeSocket.send({
    type: 'voice-join',
    channelId,
    data: {
      userId: user.id,
      name: user.name,
      avatar: user.avatar,
      muted: presence.muted,
      deafened: presence.deafened,
      streaming: presence.streaming,
    },
  });
}

/** Saiu do canal de voz */
export function sendLeave(channelId: string, userId: string) {
  realtimeSocket.send({ type: 'voice-leave', channelId, data: { userId } });
}

/** Mudo ou ensurdecido mudou: todo o servidor vê, inclusive quem não está na chamada */
export function sendVoiceState(channelId: string, muted: boolean, deafened: boolean) {
  realtimeSocket.send({ type: 'voice-state', channelId, data: { muted, deafened } });
}

/** Começou ou parou de falar */
export function sendSpeaking(channelId: string, userId: string, speaking: boolean) {
  realtimeSocket.send({ type: 'voice-speaking', channelId, data: { userId, speaking } });
}

export function sendScreenStart(channelId: string, userId: string) {
  realtimeSocket.send({ type: 'screen-start', channelId, data: { userId } });
}

export function sendScreenStop(channelId: string, userId: string) {
  realtimeSocket.send({ type: 'screen-stop', channelId, data: { userId } });
}

/** Pede a quem transmite para começar a enviar a tela para nós */
export function sendWatchScreen(channelId: string, from: string, to: string) {
  realtimeSocket.send({ type: 'screen-watch', channelId, data: { from, to } });
}

export function sendUnwatchScreen(channelId: string, from: string, to: string) {
  realtimeSocket.send({ type: 'screen-unwatch', channelId, data: { from, to } });
}

// ---------- Só na malha P2P: negociação das conexões ----------

/** Responde a quem acabou de entrar contando que já estamos no canal */
export function sendAnnounce(channelId: string, to: string, user: User, presence: VoicePresence) {
  realtimeSocket.send({
    type: 'voice-announce',
    channelId,
    data: {
      to,
      user: {
        id: user.id,
        name: user.name,
        avatar: user.avatar,
        muted: presence.muted,
        deafened: presence.deafened,
        streaming: presence.streaming,
      },
    },
  });
}

export function sendOffer(channelId: string, from: string, to: string, offer: RTCSessionDescription | null) {
  realtimeSocket.send({ type: 'voice-offer', channelId, data: { from, to, offer } });
}

export function sendAnswer(channelId: string, from: string, to: string, answer: RTCSessionDescription | null) {
  realtimeSocket.send({ type: 'voice-answer', channelId, data: { from, to, answer } });
}

export function sendCandidate(channelId: string, from: string, to: string, candidate: RTCIceCandidate) {
  realtimeSocket.send({ type: 'voice-candidate', channelId, data: { from, to, candidate } });
}

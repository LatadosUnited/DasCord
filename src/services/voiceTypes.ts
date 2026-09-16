// O contrato da voz, comum aos dois motores (SFU e P2P) e à fachada que escolhe
// entre eles. Fica separado para que nenhum motor precise importar do outro.
import { VoiceParticipant } from '../types';

/** ok: microfone escolhido; fallback: o escolhido sumiu e usamos o padrão; unavailable: nenhum */
export type InputStatus = 'ok' | 'fallback' | 'unavailable';

/** Por onde a voz está passando agora */
export type VoiceMode = 'sfu' | 'p2p';

/** Credenciais de entrada no canal, emitidas pelo servidor Rust */
export interface VoiceCredentials {
  url: string;
  token: string;
  room: string;
}

export type ParticipantsListener = (participants: VoiceParticipant[]) => void;

export interface ScreenShareSnapshot {
  /** Nossa transmissão, para a prévia local */
  local: MediaStream | null;
  /** Quantas pessoas estão assistindo a nossa tela */
  viewerCount: number;
  /** Participantes cuja tela escolhemos assistir */
  watching: string[];
  /** Vídeo já recebido de cada participante assistido */
  remote: Record<string, MediaStream>;
}

export const EMPTY_SCREEN_SNAPSHOT: ScreenShareSnapshot = {
  local: null,
  viewerCount: 0,
  watching: [],
  remote: {},
};

/** O que a fachada precisa de cada implementação de voz */
export interface VoiceEngine {
  leave(): void;
  setMuted(muted: boolean): void;
  setDeafened(deafened: boolean): void;
  startScreenShare(): Promise<string | null>;
  stopScreenShare(): void;
  watchScreen(peerId: string): void;
  stopWatchingScreen(peerId: string): void;
  retryMicrophone(): Promise<boolean>;
  subscribeScreenShare(cb: () => void): () => void;
  getScreenShareSnapshot(): ScreenShareSnapshot;
  subscribeInputStatus(cb: () => void): () => void;
  getInputStatus(): InputStatus;
}

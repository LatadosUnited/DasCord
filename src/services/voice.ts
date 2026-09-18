// Por onde a voz passa: servidor de mídia (SFU), quando o servidor tem um configurado,
// ou malha P2P entre os apps como reserva. Os componentes falam só com este arquivo.
import { useSyncExternalStore } from 'react';
import { User } from '../types';
import { request } from './api';
import { webrtcVoice } from './webrtc';
import { sfuVoice } from './sfuVoice';
import {
  EMPTY_SCREEN_SNAPSHOT,
  EntradaListener,
  InputStatus,
  ParticipantsListener,
  ScreenShareSnapshot,
  VoiceCredentials,
  VoiceEngine,
  VoiceMode,
} from './voiceTypes';

export type { VoiceCredentials, VoiceEngine, VoiceMode } from './voiceTypes';

/** 503 aqui significa "este servidor não tem SFU": a voz então usa P2P */
const apiGetVoiceToken = (channelId: string) =>
  request<VoiceCredentials>(`/api/voice/token?channelId=${encodeURIComponent(channelId)}`);

class VoiceService {
  private engine: VoiceEngine | null = null;
  private mode: VoiceMode | null = null;
  private modeListeners: Set<() => void> = new Set();
  // Incrementado a cada join/leave; um join que termina com geração diferente foi cancelado
  private joinGeneration = 0;

  async join(channelId: string, user: User, onParticipants: ParticipantsListener) {
    this.leave();
    const generation = this.joinGeneration;

    const res = await apiGetVoiceToken(channelId);
    if (generation !== this.joinGeneration) return;

    if (res.ok) {
      this.engine = sfuVoice;
      this.setMode('sfu');
      await sfuVoice.join(channelId, user, onParticipants, res.data);
    } else {
      // Sem SFU configurado, ou servidor fora do ar: cada app manda o áudio para todos
      console.info('[DasCord] Voz em modo P2P:', res.error);
      this.engine = webrtcVoice;
      this.setMode('p2p');
      await webrtcVoice.join(channelId, user, onParticipants);
    }
  }

  leave() {
    this.joinGeneration++;
    this.engine?.leave();
    this.engine = null;
    this.setMode(null);
  }

  // Mudo e ensurdecido valem para a próxima chamada também, então vão para as duas
  // implementações: a que não está em uso apenas guarda o valor.
  setMuted(muted: boolean) {
    webrtcVoice.setMuted(muted);
    sfuVoice.setMuted(muted);
  }

  setDeafened(deafened: boolean) {
    webrtcVoice.setDeafened(deafened);
    sfuVoice.setDeafened(deafened);
  }

  startScreenShare(): Promise<string | null> {
    return this.engine?.startScreenShare() ?? Promise.resolve(null);
  }

  stopScreenShare() {
    this.engine?.stopScreenShare();
  }

  watchScreen(peerId: string) {
    this.engine?.watchScreen(peerId);
  }

  stopWatchingScreen(peerId: string) {
    this.engine?.stopWatchingScreen(peerId);
  }

  retryMicrophone(): Promise<boolean> {
    return this.engine?.retryMicrophone() ?? Promise.resolve(false);
  }

  /** Só o SFU carrega entrada; em P2P as duas chamadas não fazem nada */
  enviarEntrada(destino: string, dados: Uint8Array<ArrayBuffer>, confiavel: boolean, topico?: string) {
    this.engine?.enviarEntrada(destino, dados, confiavel, topico);
  }

  subscribeEntrada = (cb: EntradaListener) => {
    const unsubs = [webrtcVoice.subscribeEntrada(cb), sfuVoice.subscribeEntrada(cb)];
    return () => unsubs.forEach((unsub) => unsub());
  };

  // As duas implementações são observadas ao mesmo tempo; só a ativa emite algo
  subscribeScreenShare = (cb: () => void) => {
    const unsubs = [webrtcVoice.subscribeScreenShare(cb), sfuVoice.subscribeScreenShare(cb)];
    return () => unsubs.forEach((unsub) => unsub());
  };

  getScreenShareSnapshot = (): ScreenShareSnapshot => this.engine?.getScreenShareSnapshot() ?? EMPTY_SCREEN_SNAPSHOT;

  subscribeInputStatus = (cb: () => void) => {
    const unsubs = [webrtcVoice.subscribeInputStatus(cb), sfuVoice.subscribeInputStatus(cb)];
    return () => unsubs.forEach((unsub) => unsub());
  };

  getInputStatus = (): InputStatus => this.engine?.getInputStatus() ?? 'ok';

  subscribeMode = (cb: () => void) => {
    this.modeListeners.add(cb);
    return () => {
      this.modeListeners.delete(cb);
    };
  };

  getMode = (): VoiceMode | null => this.mode;

  private setMode(mode: VoiceMode | null) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.modeListeners.forEach((cb) => cb());
  }
}

export const voice = new VoiceService();

export function useScreenShare(): ScreenShareSnapshot {
  return useSyncExternalStore(voice.subscribeScreenShare, voice.getScreenShareSnapshot);
}

export function useInputStatus(): InputStatus {
  return useSyncExternalStore(voice.subscribeInputStatus, voice.getInputStatus);
}

export function useVoiceMode(): VoiceMode | null {
  return useSyncExternalStore(voice.subscribeMode, voice.getMode);
}

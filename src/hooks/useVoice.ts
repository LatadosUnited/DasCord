import { useCallback, useEffect, useRef, useState } from 'react';
import { Channel, User, VoiceParticipant, VoiceState } from '../types';
import { SocketEvent } from '../services/socket';
import { voice } from '../services/voice';
import {
  VoiceRosters,
  applyVoiceRosterEvent,
  replaceServerRosters,
  rostersFromSnapshot,
} from '../services/voiceRoster';

/**
 * A chamada em que estamos e quem está em cada canal de voz do servidor aberto.
 * Fala só com a fachada `voice`, que decide entre SFU e P2P.
 */
export function useVoice() {
  const [voiceState, setVoiceState] = useState<VoiceState>({
    connected: false,
    muted: false,
    deafened: false,
    pingMs: 14,
    participants: [],
  });
  // Ao ensurdecer, lembra o mute atual; ao sair, restaura em vez de sempre desmutar
  const mutedBeforeDeafenRef = useRef(false);
  const [showVoiceStage, setShowVoiceStage] = useState(false);
  // Quem está em cada canal de voz, mesmo sem entrar na chamada
  const [voiceRosters, setVoiceRosters] = useState<VoiceRosters>({});

  // Lido dentro dos listeners do WebSocket, que não enxergam o estado atual
  const voiceChannelIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    voiceChannelIdRef.current = voiceState.channelId;
  }, [voiceState.channelId]);

  const leave = useCallback(() => {
    voice.leave();
    setVoiceState((prev) => ({
      ...prev,
      connected: false,
      channelId: undefined,
      channelName: undefined,
      participants: [],
    }));
    setShowVoiceStage(false);
  }, []);

  /** Entra no canal de voz; se já estivermos nele, só mostra ou esconde o palco */
  const enterOrToggleStage = useCallback(
    (channel: Channel, user: User, serverName?: string) => {
      if (voiceState.connected && voiceState.channelId === channel.id) {
        setShowVoiceStage((prev) => !prev);
        return;
      }
      voice.join(channel.id, user, (participants: VoiceParticipant[]) => {
        setVoiceState((current) => ({ ...current, participants }));
      });
      setVoiceState({
        connected: true,
        channelId: channel.id,
        channelName: channel.name,
        serverName,
        muted: voiceState.muted,
        deafened: voiceState.deafened,
        pingMs: Math.floor(Math.random() * 8) + 12,
        participants: [
          {
            id: user.id,
            name: user.name,
            avatar: user.avatar,
            speaking: false,
            muted: voiceState.muted,
            deafened: voiceState.deafened,
            streaming: false,
          },
        ],
      });
      setShowVoiceStage(true);
    },
    [voiceState.connected, voiceState.channelId, voiceState.muted, voiceState.deafened]
  );

  const hideStage = useCallback(() => setShowVoiceStage(false), []);

  const toggleMute = useCallback(() => {
    const muted = !voiceState.muted;
    setVoiceState((prev) => ({ ...prev, muted }));
    voice.setMuted(muted);
  }, [voiceState.muted]);

  const toggleDeafen = useCallback(() => {
    const deafened = !voiceState.deafened;
    if (deafened) mutedBeforeDeafenRef.current = voiceState.muted;
    const muted = deafened ? true : mutedBeforeDeafenRef.current;
    setVoiceState((prev) => ({ ...prev, deafened, muted }));
    voice.setDeafened(deafened);
    voice.setMuted(muted);
  }, [voiceState.muted, voiceState.deafened]);

  const applyRosterEvent = useCallback((event: SocketEvent) => {
    setVoiceRosters((prev) => applyVoiceRosterEvent(prev, event));
  }, []);

  const loadServerRosters = useCallback(
    (channelIds: string[], channels: Record<string, Omit<VoiceParticipant, 'speaking'>[]>) => {
      setVoiceRosters((prev) => replaceServerRosters(prev, channelIds, rostersFromSnapshot(channels)));
    },
    []
  );

  // Eventos perdidos enquanto offline: a lista volta completa ao reconectar
  const clearRosters = useCallback(() => setVoiceRosters({}), []);

  /** Sai da chamada se ela for neste canal (o canal foi apagado ou perdemos o acesso) */
  const leaveIfInChannel = useCallback(
    (channelId: string | undefined) => {
      if (channelId && voiceChannelIdRef.current === channelId) leave();
    },
    [leave]
  );

  const getVoiceChannelId = useCallback(() => voiceChannelIdRef.current, []);

  const reset = useCallback(() => {
    leave();
    clearRosters();
  }, [leave, clearRosters]);

  return {
    voiceState,
    voiceRosters,
    showVoiceStage,
    enterOrToggleStage,
    hideStage,
    leave,
    leaveIfInChannel,
    getVoiceChannelId,
    toggleMute,
    toggleDeafen,
    applyRosterEvent,
    loadServerRosters,
    clearRosters,
    reset,
  };
}

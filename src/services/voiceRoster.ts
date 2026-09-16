import { VoiceParticipant } from '../types';
import { SocketEvent } from './socket';

/** Participantes de cada canal de voz, visto de fora da chamada */
export type VoiceRosters = Record<string, VoiceParticipant[]>;

export function rostersFromSnapshot(channels: Record<string, Omit<VoiceParticipant, 'speaking'>[]>): VoiceRosters {
  const rosters: VoiceRosters = {};
  for (const [channelId, members] of Object.entries(channels)) {
    rosters[channelId] = members.map((m) => ({ ...m, speaking: false }));
  }
  return rosters;
}

/** Troca os canais de um servidor pelo retrato atual vindo da API */
export function replaceServerRosters(prev: VoiceRosters, serverChannelIds: string[], snapshot: VoiceRosters): VoiceRosters {
  const next = { ...prev };
  for (const id of serverChannelIds) delete next[id];
  return { ...next, ...snapshot };
}

function withoutUser(rosters: VoiceRosters, userId: string): VoiceRosters {
  let changed = false;
  const next: VoiceRosters = {};
  for (const [channelId, list] of Object.entries(rosters)) {
    const filtered = list.filter((p) => p.id !== userId);
    if (filtered.length !== list.length) changed = true;
    if (filtered.length > 0) next[channelId] = filtered;
  }
  return changed ? next : rosters;
}

function patchUser(rosters: VoiceRosters, channelId: string, userId: string, patch: Partial<VoiceParticipant>): VoiceRosters {
  const list = rosters[channelId];
  if (!list?.some((p) => p.id === userId)) return rosters;
  return { ...rosters, [channelId]: list.map((p) => (p.id === userId ? { ...p, ...patch } : p)) };
}

/** Aplica um evento de voz do WebSocket; devolve o mesmo objeto se nada mudou */
export function applyVoiceRosterEvent(rosters: VoiceRosters, event: SocketEvent): VoiceRosters {
  const { type, channelId, data } = event;
  if (!data?.userId) return rosters;

  switch (type) {
    case 'voice-join': {
      // Um usuário fica em um canal por vez
      const next = withoutUser(rosters, data.userId);
      const participant: VoiceParticipant = {
        id: data.userId,
        name: data.name,
        avatar: data.avatar,
        speaking: false,
        muted: !!data.muted,
        deafened: !!data.deafened,
        streaming: !!data.streaming,
      };
      return { ...next, [channelId]: [...(next[channelId] ?? []), participant] };
    }
    case 'voice-leave': {
      const list = rosters[channelId];
      if (!list?.some((p) => p.id === data.userId)) return rosters;
      const filtered = list.filter((p) => p.id !== data.userId);
      const next = { ...rosters };
      if (filtered.length > 0) next[channelId] = filtered;
      else delete next[channelId];
      return next;
    }
    case 'voice-state':
      return patchUser(rosters, channelId, data.userId, { muted: !!data.muted, deafened: !!data.deafened });
    case 'voice-speaking':
      return patchUser(rosters, channelId, data.userId, { speaking: !!data.speaking });
    case 'screen-start':
    case 'screen-stop':
      return patchUser(rosters, channelId, data.userId, { streaming: type === 'screen-start' });
    default:
      return rosters;
  }
}

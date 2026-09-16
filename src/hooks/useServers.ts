import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Channel, Server, User, VoiceParticipant } from '../types';
import { ChannelDialogMode } from '../components/servers/ChannelDialog';
import {
  ServerDto,
  apiGetServerMembers,
  apiGetServerVoice,
  apiListServers,
  toServer,
} from '../services/servers';

/** Diálogos abertos pela lista de servidores ou pelo menu do servidor */
export type ServerDialog =
  | { kind: 'add' }
  | { kind: 'invite' | 'settings' | 'leave'; serverId: string };

export type ChannelDialogState = {
  mode: ChannelDialogMode;
  channel?: Channel;
  category?: string;
};

/** O que os servidores precisam da voz: sair da chamada e preencher o roster do canal */
export interface VoiceLink {
  leaveIfInChannel: (channelId: string | undefined) => void;
  getVoiceChannelId: () => string | undefined;
  hideStage: () => void;
  loadServerRosters: (
    channelIds: string[],
    channels: Record<string, Omit<VoiceParticipant, 'speaking'>[]>
  ) => void;
}

interface Options {
  isAuthenticated: boolean;
  serverOnline: boolean;
  voice: VoiceLink;
}

/** Servidores, canais, membros e os diálogos que mexem neles */
export function useServers({ isAuthenticated, serverOnline, voice }: Options) {
  const [servers, setServers] = useState<Server[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeServerId, setActiveServerId] = useState<string>('home');
  const [activeChannelId, setActiveChannelId] = useState<string>('');
  // Membros por servidor; ausente = ainda não carregado
  const [members, setMembers] = useState<Record<string, User[]>>({});
  const [serverDialog, setServerDialog] = useState<ServerDialog | null>(null);
  const [channelDialog, setChannelDialog] = useState<ChannelDialogState | null>(null);
  // A primeira carga de servidores da sessão abre o DasIdeia HQ
  const openedInitialServerRef = useRef(false);

  // Lido dentro dos listeners do WebSocket, que não enxergam o estado atual
  const channelsRef = useRef<Channel[]>([]);
  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  const openServer = useCallback(
    (serverId: string, serverChannels: Channel[]) => {
      setActiveServerId(serverId);
      voice.hideStage();
      const firstText = serverChannels.find((c) => c.type === 'text');
      if (firstText) {
        setActiveChannelId(firstText.id);
      }
    },
    [voice]
  );

  const selectServer = useCallback(
    (serverId: string) => {
      if (serverId === 'home') {
        setActiveServerId('home');
        return;
      }
      openServer(
        serverId,
        channelsRef.current.filter((c) => c.serverId === serverId)
      );
    },
    [openServer]
  );

  const selectTextChannel = useCallback(
    (channel: Channel) => {
      setActiveChannelId(channel.id);
      voice.hideStage();
    },
    [voice]
  );

  // Coloca ou atualiza um servidor vindo da API, junto com os canais dele
  const upsertServer = useCallback((dto: ServerDto) => {
    const server = toServer(dto);
    setServers((prev) =>
      prev.some((s) => s.id === server.id)
        ? prev.map((s) => (s.id === server.id ? server : s))
        : [...prev, server]
    );
    setChannels((prev) => [...prev.filter((c) => c.serverId !== dto.id), ...dto.channels]);
  }, []);

  // Tira o servidor da tela (saiu, foi excluído ou perdeu o acesso)
  const removeServerLocally = useCallback(
    (serverId: string) => {
      const voiceChannel = channelsRef.current.find((c) => c.id === voice.getVoiceChannelId());
      if (voiceChannel?.serverId === serverId) {
        voice.leaveIfInChannel(voiceChannel.id);
      }
      setServers((prev) => prev.filter((s) => s.id !== serverId));
      setChannels((prev) => prev.filter((c) => c.serverId !== serverId));
      setMembers((prev) => {
        if (!(serverId in prev)) return prev;
        const next = { ...prev };
        delete next[serverId];
        return next;
      });
      setActiveServerId((prev) => (prev === serverId ? 'home' : prev));
      setServerDialog((prev) =>
        prev && 'serverId' in prev && prev.serverId === serverId ? null : prev
      );
    },
    [voice]
  );

  /** O canal sumiu: quem estava na chamada dele sai, e quem o tinha aberto vai para outro */
  const removeChannelLocally = useCallback(
    (channelId: string) => {
      voice.leaveIfInChannel(channelId);
      const apagado = channelsRef.current.find((c) => c.id === channelId);
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
      setChannelDialog((prev) => (prev?.channel?.id === channelId ? null : prev));
      setActiveChannelId((prev) => {
        if (prev !== channelId) return prev;
        const proximo = channelsRef.current.find(
          (c) => c.serverId === apagado?.serverId && c.type === 'text' && c.id !== channelId
        );
        return proximo?.id ?? '';
      });
    },
    [voice]
  );

  const loadServers = useCallback(async () => {
    const res = await apiListServers();
    if (!res.ok) {
      console.warn('Não foi possível carregar os servidores:', res.error);
      return;
    }
    const dtos = res.data.servers;
    setServers(dtos.map(toServer));
    setChannels(dtos.flatMap((d) => d.channels));

    if (!openedInitialServerRef.current) {
      openedInitialServerRef.current = true;
      const initial = dtos.find((d) => d.isDefault) ?? dtos[0];
      if (initial) {
        openServer(initial.id, initial.channels);
      }
    }
    // Perdeu o acesso ao servidor aberto enquanto estava desconectado
    setActiveServerId((prev) => (prev === 'home' || dtos.some((d) => d.id === prev) ? prev : 'home'));
  }, [openServer]);

  const upsertMember = useCallback((serverId: string, member: User) => {
    setMembers((prev) => {
      const list = prev[serverId];
      // Lista ainda não carregada: vem completa quando o servidor for aberto
      if (!list) return prev;
      const exists = list.some((m) => m.id === member.id);
      return {
        ...prev,
        [serverId]: exists ? list.map((m) => (m.id === member.id ? member : m)) : [...list, member],
      };
    });
  }, []);

  const removeMember = useCallback((serverId: string, userId: string) => {
    setMembers((prev) => {
      const list = prev[serverId];
      if (!list) return prev;
      return { ...prev, [serverId]: list.filter((m) => m.id !== userId) };
    });
  }, []);

  /** Perfil, avatar ou status mudou: reflete em toda lista de membros que mostra a pessoa */
  const applyUserUpdate = useCallback((updated: User) => {
    setMembers((prev) => {
      let changed = false;
      const next: Record<string, User[]> = {};
      for (const [serverId, list] of Object.entries(prev)) {
        next[serverId] = list.map((m) => {
          if (m.id !== updated.id) return m;
          changed = true;
          return { ...m, ...updated };
        });
      }
      return changed ? next : prev;
    });
  }, []);

  // Busca os servidores ao entrar e de novo a cada reconexão (pega o que mudou offline)
  useEffect(() => {
    if (isAuthenticated && serverOnline) {
      loadServers();
    }
  }, [isAuthenticated, serverOnline, loadServers]);

  // Lista de membros do servidor aberto, com a presença de agora
  const memberListServerId = activeServerId !== 'home' ? activeServerId : null;
  useEffect(() => {
    if (!isAuthenticated || !serverOnline || !memberListServerId) return;
    let cancelled = false;
    apiGetServerMembers(memberListServerId).then((res) => {
      if (cancelled || !res.ok) return;
      setMembers((prev) => ({ ...prev, [memberListServerId]: res.data.members }));
    });
    apiGetServerVoice(memberListServerId).then((res) => {
      if (cancelled || !res.ok) return;
      const channelIds = channelsRef.current
        .filter((c) => c.serverId === memberListServerId)
        .map((c) => c.id);
      voice.loadServerRosters(channelIds, res.data.channels);
    });
    return () => {
      cancelled = true;
    };
  }, [memberListServerId, isAuthenticated, serverOnline, voice]);

  const reset = useCallback(() => {
    openedInitialServerRef.current = false;
    setServers([]);
    setChannels([]);
    setMembers({});
    setActiveServerId('home');
    setActiveChannelId('');
    setServerDialog(null);
  }, []);

  const currentServer = servers.find((s) => s.id === activeServerId);
  const currentServerChannels = useMemo(
    () => channels.filter((c) => c.serverId === activeServerId),
    [channels, activeServerId]
  );

  return {
    servers,
    activeServerId,
    activeChannelId,
    members,
    currentServer,
    currentServerChannels,
    serverDialog,
    setServerDialog,
    channelDialog,
    setChannelDialog,
    openServer,
    selectServer,
    selectTextChannel,
    upsertServer,
    removeServerLocally,
    removeChannelLocally,
    loadServers,
    upsertMember,
    removeMember,
    applyUserUpdate,
    reset,
  };
}

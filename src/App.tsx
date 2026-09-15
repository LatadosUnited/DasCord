import { useState, useEffect, useCallback, useRef } from 'react';
import { TitleBar } from './components/TitleBar';
import { ServerList } from './components/ServerList';
import { ChannelSidebar } from './components/ChannelSidebar';
import { DMSidebar } from './components/DMSidebar';
import { FriendsHub } from './components/FriendsHub';
import { ChatArea } from './components/ChatArea';
import { VoiceStage } from './components/VoiceStage';
import { MemberList } from './components/MemberList';
import { RustStatsModal } from './components/RustStatsModal';
import { SettingsModal } from './components/SettingsModal';
import { AuthScreen } from './components/AuthScreen';
import { ConfirmDialog } from './components/ConfirmDialog';
import { AddServerModal } from './components/servers/AddServerModal';
import { InviteModal } from './components/servers/InviteModal';
import { ServerSettingsModal } from './components/servers/ServerSettingsModal';
import { VersionBanner } from './components/VersionBanner';
import { APP_VERSION, ServerVersionInfo, apiGetServerVersion } from './services/version';
import {
  Server,
  Channel,
  User,
  UserStatus,
  Message,
  SettingsTab,
  VoiceState,
  SystemStats,
} from './types';
import { realtimeSocket, SocketEvent } from './services/socket';
import { voice } from './services/voice';
import { generateLocalSnowflake } from './services/snowflake';
import {
  getLocalSession,
  clearLocalSession,
  saveLocalSession,
  apiVerifySession,
  apiLogout,
} from './services/auth';
import { apiUpdatePresence } from './services/users';
import './App.css';
import { apiGetFriends, FriendsSummary } from './services/friends';
import { apiGetChannelMessages, mergeMessages, withTimestamp } from './services/messages';
import {
  VoiceRosters,
  applyVoiceRosterEvent,
  replaceServerRosters,
  rostersFromSnapshot,
} from './services/voiceRoster';
import {
  ServerDto,
  apiGetServerVoice,
  apiGetServerMembers,
  apiLeaveServer,
  apiListServers,
  toServer,
} from './services/servers';

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

/** Diálogos abertos pela lista de servidores ou pelo menu do servidor */
type ServerDialog =
  | { kind: 'add' }
  | { kind: 'invite' | 'settings' | 'leave'; serverId: string };

export function App() {
  // Authentication State
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);

  // Application State
  const [servers, setServers] = useState<Server[]>([]);
  const [activeServerId, setActiveServerId] = useState<string>('home');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string>('');
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  // Membros por servidor; ausente = ainda não carregado
  const [members, setMembers] = useState<Record<string, User[]>>({});
  const [currentUser, setCurrentUser] = useState<User>(SIGNED_OUT_USER);
  const [serverOnline, setServerOnline] = useState<boolean>(false);
  const [showVoiceStage, setShowVoiceStage] = useState<boolean>(false);
  const [serverDialog, setServerDialog] = useState<ServerDialog | null>(null);
  const [serverVersion, setServerVersion] = useState<ServerVersionInfo | null>(null);
  // A primeira carga de servidores da sessão abre o DasIdeia HQ
  const openedInitialServerRef = useRef(false);

  // Friends & DMs State
  const [friendsSummary, setFriendsSummary] = useState<FriendsSummary>({
    friends: [],
    incoming_requests: [],
    outgoing_requests: [],
  });
  const [activeDMUser, setActiveDMUser] = useState<User | null>(null);

  // Voice State
  const [voiceState, setVoiceState] = useState<VoiceState>({
    connected: false,
    muted: false,
    deafened: false,
    pingMs: 14,
    participants: [],
  });
  const mutedBeforeDeafenRef = useRef(false);
  // Quem está em cada canal de voz, mesmo sem entrar na chamada
  const [voiceRosters, setVoiceRosters] = useState<VoiceRosters>({});

  // Valores lidos dentro dos listeners do WebSocket, que não enxergam o estado atual
  const currentUserIdRef = useRef('');
  const channelsRef = useRef<Channel[]>([]);
  const voiceChannelIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    currentUserIdRef.current = currentUser.id;
  }, [currentUser.id]);
  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);
  useEffect(() => {
    voiceChannelIdRef.current = voiceState.channelId;
  }, [voiceState.channelId]);

  // UI Panels & Modals
  const [showMemberList, setShowMemberList] = useState(true);
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);

  // Fetch Rust system stats via Tauri IPC
  const fetchStats = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const data = await invoke<SystemStats>('get_system_stats');
      setStats(data);
    } catch (e) {
      // Fallback for direct browser preview
      setStats({
        app_name: 'DasCord (Browser Mode)',
        version: APP_VERSION,
        engine: 'Tauri v2 + Webview2 / V8 Engine',
        ram_usage_mb: 38.4,
        rust_version: 'Rust 1.96.0',
        ping_ms: 1,
      });
    }
  };

  // Refresh friends from Rust server
  const refreshFriends = useCallback(async () => {
    const { token } = getLocalSession();
    if (token) {
      const summary = await apiGetFriends(token);
      if (summary) {
        setFriendsSummary(summary);
      }
    }
  }, []);

  const leaveVoice = useCallback(() => {
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

  // Encerra a sessão local: sai da voz, desconecta o socket e volta para o login.
  // Não lê estado do componente, então é seguro chamar de dentro de listeners.
  const endSession = useCallback(() => {
    leaveVoice();
    realtimeSocket.setToken(null);
    clearLocalSession();
    setIsAuthenticated(false);
    // Nada da conta anterior pode aparecer para quem entrar depois
    openedInitialServerRef.current = false;
    setServers([]);
    setChannels([]);
    setMembers({});
    setVoiceRosters({});
    setMessages({});
    setActiveServerId('home');
    setActiveChannelId('');
    setActiveDMUser(null);
    setServerDialog(null);
  }, [leaveVoice]);

  // Aplica um usuário atualizado pelo servidor em todos os lugares onde ele aparece
  const applyUserUpdate = useCallback((updated: User) => {
    const merge = (u: User) => (u.id === updated.id ? { ...u, ...updated } : u);
    setCurrentUser(merge);
    setActiveDMUser((prev) => (prev ? merge(prev) : prev));
    setFriendsSummary((prev) => ({
      friends: prev.friends.map(merge),
      incoming_requests: prev.incoming_requests.map((r) => ({ ...r, from_user: merge(r.from_user) })),
      outgoing_requests: prev.outgoing_requests.map((r) => ({ ...r, to_user: merge(r.to_user) })),
    }));
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

    const { token, user } = getLocalSession();
    if (token && user?.id === updated.id) {
      saveLocalSession(token, { ...user, ...updated });
    }
  }, []);

  // ---------- Servidores ----------

  const openServer = useCallback((serverId: string, serverChannels: Channel[]) => {
    setActiveServerId(serverId);
    setShowVoiceStage(false);
    const firstText = serverChannels.find((c) => c.type === 'text');
    if (firstText) {
      setActiveChannelId(firstText.id);
    }
  }, []);

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
      const voiceChannel = channelsRef.current.find((c) => c.id === voiceChannelIdRef.current);
      if (voiceChannel?.serverId === serverId) {
        leaveVoice();
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
      setServerDialog((prev) => (prev && 'serverId' in prev && prev.serverId === serverId ? null : prev));
    },
    [leaveVoice]
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

  useEffect(() => {
    fetchStats();

    // Verifica sessão salva no localStorage
    const { token, user } = getLocalSession();
    if (token && user) {
      setCurrentUser(user);
      setIsAuthenticated(true);
      refreshFriends();
      realtimeSocket.setToken(token);
      // Valida com o servidor Rust em segundo plano
      apiVerifySession(token).then((check) => {
        if (check.status === 'valid') {
          setCurrentUser(check.user);
        } else if (check.status === 'invalid') {
          // Token rejeitado (401): limpa sessão e desautentica
          endSession();
        }
        // 'unreachable': servidor offline, mantém a sessão local
      });
    }

    const unsubStatus = realtimeSocket.subscribeStatus((connected) => {
      setServerOnline(connected);
      // Eventos perdidos enquanto offline: a lista volta completa ao reconectar
      if (!connected) setVoiceRosters({});
    });
    // O servidor recusou o token na conexão do WebSocket (ex: sessão expirou)
    const unsubAuthError = realtimeSocket.subscribeAuthError(endSession);

    const unsubMessages = realtimeSocket.subscribeMessages((event: SocketEvent) => {
      if (event.type.startsWith('voice-') || event.type.startsWith('screen-')) {
        setVoiceRosters((prev) => applyVoiceRosterEvent(prev, event));
        return;
      }
      if (event.type === 'message' && event.data) {
        const incomingMsg: Message = withTimestamp(event.data);
        setMessages((prev) => ({
          ...prev,
          [event.channelId]: mergeMessages(prev[event.channelId] || [], [incomingMsg]),
        }));
      } else if (event.type === 'user-updated' && event.data) {
        // Perfil, avatar ou status mudou (seu, em outra sessão, de um amigo ou de um membro)
        applyUserUpdate(event.data as User);
      } else if (
        event.type === 'friend-request-received' ||
        event.type === 'friend-request-accepted'
      ) {
        refreshFriends();
      } else if (event.type === 'server-member-joined' && event.data) {
        const { serverId, member } = event.data as { serverId: string; member: User };
        if (member.id === currentUserIdRef.current) {
          // Criou ou entrou em um servidor (talvez em outra sessão): busca a lista completa
          loadServers();
        } else {
          upsertMember(serverId, member);
        }
      } else if (event.type === 'server-member-left' && event.data) {
        const { serverId, userId } = event.data as { serverId: string; userId: string };
        if (userId === currentUserIdRef.current) {
          removeServerLocally(serverId);
        } else {
          removeMember(serverId, userId);
        }
      } else if (event.type === 'server-updated' && event.data?.server) {
        upsertServer(event.data.server as ServerDto);
      } else if (event.type === 'server-deleted' && event.data) {
        removeServerLocally(event.data.serverId as string);
      }
    });

    return () => {
      unsubStatus();
      unsubAuthError();
      unsubMessages();
    };
  }, [
    refreshFriends,
    endSession,
    applyUserUpdate,
    loadServers,
    upsertMember,
    removeMember,
    upsertServer,
    removeServerLocally,
  ]);

  // Versão do servidor: ao abrir o app e a cada reconexão (ele pode ter sido atualizado)
  useEffect(() => {
    let cancelled = false;
    apiGetServerVersion().then((info) => {
      if (!cancelled && info) setServerVersion(info);
    });
    return () => {
      cancelled = true;
    };
  }, [serverOnline]);

  // Busca os servidores ao entrar e de novo a cada reconexão (pega o que mudou offline)
  useEffect(() => {
    if (isAuthenticated && serverOnline) {
      loadServers();
    }
  }, [isAuthenticated, serverOnline, loadServers]);

  const isDM = activeServerId === 'home' && activeDMUser !== null;
  // ID simétrico determinístico para que ambos os participantes vejam o mesmo canal de DM
  const currentChannelId = isDM
    ? `dm_${[currentUser.id, activeDMUser!.id].sort().join('_')}`
    : activeChannelId;

  // Filter channels by current active server
  const currentServerChannels = channels.filter(
    (c) => c.serverId === activeServerId
  );
  const currentServer = servers.find((s) => s.id === activeServerId);

  const currentChannel: Channel | undefined = isDM
    ? {
        id: currentChannelId,
        serverId: 'home',
        name: activeDMUser!.name,
        type: 'text',
        topic: `Início do histórico de mensagens diretas com ${activeDMUser!.name} (${activeDMUser!.tag})`,
        category: 'MENSAGENS DIRETAS',
      }
    : currentServerChannels.find((c) => c.id === activeChannelId && c.type === 'text');

  const currentMessages = messages[currentChannelId] || [];

  // Carrega o histórico salvo ao abrir um canal, e de novo ao reconectar (pega o que chegou offline)
  useEffect(() => {
    if (!isAuthenticated || !serverOnline || !currentChannelId) return;
    const { token } = getLocalSession();
    if (!token) return;

    let cancelled = false;
    const channelId = currentChannelId;
    apiGetChannelMessages(token, channelId).then((history) => {
      if (cancelled || !history) return;
      setMessages((prev) => ({
        ...prev,
        [channelId]: mergeMessages(prev[channelId] || [], history),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [currentChannelId, isAuthenticated, serverOnline]);

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
      const channelIds = channelsRef.current.filter((c) => c.serverId === memberListServerId).map((c) => c.id);
      setVoiceRosters((prev) =>
        replaceServerRosters(prev, channelIds, rostersFromSnapshot(res.data.channels))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [memberListServerId, isAuthenticated, serverOnline]);

  // Switch server
  const handleSelectServer = (serverId: string) => {
    if (serverId === 'home') {
      setActiveServerId('home');
      setActiveDMUser(null);
      return;
    }
    openServer(serverId, channels.filter((c) => c.serverId === serverId));
  };

  // Switch or interact with channel
  const handleSelectChannel = (channel: Channel) => {
    if (channel.type === 'voice') {
      if (!voiceState.connected || voiceState.channelId !== channel.id) {
        // Conecta no canal de voz WebRTC
        voice.join(channel.id, currentUser, (participants) => {
          setVoiceState((prev) => ({ ...prev, participants }));
        });

        setVoiceState({
          connected: true,
          channelId: channel.id,
          channelName: channel.name,
          serverName: currentServer?.name,
          muted: voiceState.muted,
          deafened: voiceState.deafened,
          pingMs: Math.floor(Math.random() * 8) + 12,
          participants: [
            {
              id: currentUser.id,
              name: currentUser.name,
              avatar: currentUser.avatar,
              speaking: false,
              muted: voiceState.muted,
              deafened: voiceState.deafened,
              streaming: false,
            },
          ],
        });
        setShowVoiceStage(true);
      } else {
        // Já está conectado: alterna visualização do Voice Stage
        setShowVoiceStage((prev) => !prev);
      }
    } else {
      setActiveChannelId(channel.id);
      setShowVoiceStage(false);
    }
  };

  // Send message
  const handleSendMessage = async (text: string) => {
    const targetChannelId = currentChannelId;
    // ID local provisório: o servidor devolve a mensagem oficial com este valor em "nonce"
    const localId = generateLocalSnowflake();

    const sent = realtimeSocket.send({
      type: 'message',
      channelId: targetChannelId,
      data: { id: localId, content: text },
    });

    const newMessage: Message = {
      id: localId,
      channelId: targetChannelId,
      author: currentUser,
      content: text,
      timestamp: sent ? 'Enviando...' : 'Não enviada (sem conexão)',
      reactions: [],
      createdAt: Date.now(),
    };

    setMessages((prev) => ({
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
  };

  // Toggle emoji reactions
  const handleToggleReaction = (messageId: string, emoji: string) => {
    const targetChannelId = currentChannelId;
    setMessages((prev) => {
      const channelMsgs = prev[targetChannelId] || [];
      const updated = channelMsgs.map((m) => {
        if (m.id !== messageId) return m;
        const exists = m.reactions.find((r) => r.emoji === emoji);
        let newReactions;
        if (exists) {
          newReactions = m.reactions.map((r) => {
            if (r.emoji === emoji) {
              return {
                ...r,
                count: r.active ? r.count - 1 : r.count + 1,
                active: !r.active,
              };
            }
            return r;
          }).filter((r) => r.count > 0);
        } else {
          newReactions = [...m.reactions, { emoji, count: 1, active: true }];
        }
        return { ...m, reactions: newReactions };
      });
      return { ...prev, [targetChannelId]: updated };
    });
  };

  // Voice controls
  const handleToggleMute = () => {
    const newMuted = !voiceState.muted;
    setVoiceState((prev) => ({ ...prev, muted: newMuted }));
    voice.setMuted(newMuted);
  };

  const handleToggleDeafen = () => {
    const newDeafened = !voiceState.deafened;
    // Ao ensurdecer, lembra o mute atual; ao sair, restaura em vez de sempre desmutar
    if (newDeafened) {
      mutedBeforeDeafenRef.current = voiceState.muted;
    }
    const newMuted = newDeafened ? true : mutedBeforeDeafenRef.current;
    setVoiceState((prev) => ({
      ...prev,
      deafened: newDeafened,
      muted: newMuted,
    }));
    voice.setDeafened(newDeafened);
    voice.setMuted(newMuted);
  };

  // Status de presença: aplica na hora e desfaz se o servidor recusar
  const handleChangePresence = async (status: UserStatus, customStatus: string) => {
    const previous = currentUser;
    applyUserUpdate({ ...currentUser, status, customStatus });

    const res = await apiUpdatePresence(status, customStatus);
    if (res.ok) {
      applyUserUpdate(res.data.user);
    } else {
      applyUserUpdate(previous);
      console.warn('Não foi possível atualizar o status:', res.error);
    }
  };

  // Auth Handlers
  const handleLogin = (user: User) => {
    setCurrentUser(user);
    setIsAuthenticated(true);
    refreshFriends();
    // AuthScreen já salvou o token antes de chamar onLogin
    realtimeSocket.setToken(getLocalSession().token);
  };

  const handleLogout = () => {
    const { token } = getLocalSession();
    if (token) {
      apiLogout(token);
    }
    endSession();
  };

  if (!isAuthenticated) {
    return (
      <>
        <AuthScreen onLogin={handleLogin} />
        <VersionBanner serverVersion={serverVersion} />
      </>
    );
  }

  const closeServerDialog = () => setServerDialog(null);
  const dialogServer =
    serverDialog && 'serverId' in serverDialog
      ? servers.find((s) => s.id === serverDialog.serverId)
      : undefined;

  return (
    <div className="app-container">
      {/* Window Native Titlebar with Rust Benchmark Badge */}
      <TitleBar
        stats={stats}
        serverOnline={serverOnline}
        onOpenStats={() => setShowStatsModal(true)}
        onLogout={handleLogout}
      />

      {/* Main App Grid */}
      <div className="main-layout">
        {/* Leftmost Guilds/Servers Rail */}
        <ServerList
          servers={servers}
          activeServerId={activeServerId}
          onSelectServer={handleSelectServer}
          onAddServer={() => setServerDialog({ kind: 'add' })}
        />

        {/* Channels Sidebar or Direct Messages Sidebar */}
        {activeServerId === 'home' ? (
          <DMSidebar
            currentUser={currentUser}
            friends={friendsSummary.friends}
            pendingRequestsCount={friendsSummary.incoming_requests.length}
            activeDMUserId={activeDMUser ? activeDMUser.id : null}
            onSelectFriendsHub={() => setActiveDMUser(null)}
            onSelectFriendDM={(friend) => setActiveDMUser(friend)}
            voiceState={voiceState}
            onToggleMute={handleToggleMute}
            onToggleDeafen={handleToggleDeafen}
            onDisconnectVoice={leaveVoice}
            onOpenSettings={(tab) => setSettingsTab(tab ?? 'account')}
            onChangePresence={handleChangePresence}
          />
        ) : (
          <ChannelSidebar
            server={currentServer}
            channels={currentServerChannels}
            activeChannelId={activeChannelId}
            onSelectChannel={handleSelectChannel}
            currentUser={currentUser}
            voiceState={voiceState}
            voiceRosters={voiceRosters}
            onToggleMute={handleToggleMute}
            onToggleDeafen={handleToggleDeafen}
            onDisconnectVoice={leaveVoice}
            onOpenSettings={(tab) => setSettingsTab(tab ?? 'account')}
            onChangePresence={handleChangePresence}
            onInvite={() => setServerDialog({ kind: 'invite', serverId: activeServerId })}
            onOpenServerSettings={() => setServerDialog({ kind: 'settings', serverId: activeServerId })}
            onLeaveServer={() => setServerDialog({ kind: 'leave', serverId: activeServerId })}
          />
        )}

        {/* Main Central View: FriendsHub, Voice Stage, or Chat Area */}
        {activeServerId === 'home' && activeDMUser === null ? (
          <FriendsHub
            summary={friendsSummary}
            currentUser={currentUser}
            onRefresh={refreshFriends}
            onOpenDM={(friend) => setActiveDMUser(friend)}
          />
        ) : showVoiceStage && voiceState.connected ? (
          <VoiceStage
            channelName={voiceState.channelName || 'Canal de Voz'}
            voiceState={voiceState}
            participants={voiceState.participants}
            currentUserId={currentUser.id}
            onToggleMute={handleToggleMute}
            onToggleDeafen={handleToggleDeafen}
            onDisconnect={leaveVoice}
          />
        ) : currentChannel ? (
          <ChatArea
            channel={currentChannel}
            messages={currentMessages}
            currentUser={currentUser}
            dmUser={isDM ? activeDMUser! : undefined}
            onSendMessage={handleSendMessage}
            onToggleReaction={handleToggleReaction}
            showMemberList={showMemberList && activeServerId !== 'home'}
            onToggleMemberList={() => setShowMemberList(!showMemberList)}
          />
        ) : (
          <div className="main-placeholder">
            {serverOnline ? 'Escolha um canal de texto para conversar.' : 'Conectando ao servidor...'}
          </div>
        )}

        {/* Right Member List (only shown when inside a server) */}
        {showMemberList && currentServer && (
          <MemberList members={members[currentServer.id]} ownerId={currentServer.ownerId} />
        )}
      </div>

      {/* Rust Performance & Memory Benchmark Modal */}
      {showStatsModal && (
        <RustStatsModal
          stats={stats}
          serverVersion={serverVersion?.version ?? null}
          onClose={() => setShowStatsModal(false)}
          onRefresh={fetchStats}
        />
      )}

      {/* Configurações de usuário: Minha Conta, Perfil, Voz e Áudio */}
      {settingsTab && (
        <SettingsModal
          user={currentUser}
          initialTab={settingsTab}
          serverVersion={serverVersion?.version ?? null}
          onClose={() => setSettingsTab(null)}
          onLogout={handleLogout}
          onUserUpdated={applyUserUpdate}
        />
      )}

      <VersionBanner serverVersion={serverVersion} />

      {/* Servidores: adicionar, convidar, configurar e sair */}
      {serverDialog?.kind === 'add' && (
        <AddServerModal
          currentUser={currentUser}
          onClose={closeServerDialog}
          onServerReady={(dto) => {
            upsertServer(dto);
            openServer(dto.id, dto.channels);
            closeServerDialog();
          }}
        />
      )}
      {serverDialog?.kind === 'invite' && dialogServer && (
        <InviteModal server={dialogServer} currentUser={currentUser} onClose={closeServerDialog} />
      )}
      {serverDialog?.kind === 'settings' && dialogServer && (
        <ServerSettingsModal
          server={dialogServer}
          onClose={closeServerDialog}
          onServerUpdated={upsertServer}
          onDeleted={removeServerLocally}
        />
      )}
      {serverDialog?.kind === 'leave' && dialogServer && (
        <ConfirmDialog
          title={`Sair de ${dialogServer.name}?`}
          message="Você deixa de ver os canais e as mensagens deste servidor. Para voltar, vai precisar de um novo convite."
          confirmLabel="Sair do servidor"
          onConfirm={async () => {
            const res = await apiLeaveServer(dialogServer.id);
            if (!res.ok) return res.error;
            removeServerLocally(dialogServer.id);
            return null;
          }}
          onClose={closeServerDialog}
        />
      )}
    </div>
  );
}

export default App;

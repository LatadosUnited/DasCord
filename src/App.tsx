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
import {
  CURRENT_USER,
  MOCK_SERVERS,
  MOCK_CHANNELS,
  INITIAL_MESSAGES,
  MOCK_USERS,
} from './mockData';
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
import { webrtcVoice } from './services/webrtc';
import { generateLocalSnowflake } from './services/snowflake';
import {
  getLocalSession,
  clearLocalSession,
  saveLocalSession,
  apiVerifySession,
  apiLogout,
} from './services/auth';
import { apiUpdatePresence } from './services/users';
import { apiGetFriends, FriendsSummary } from './services/friends';
import { apiGetChannelMessages, mergeMessages, withTimestamp } from './services/messages';

export function App() {
  // Authentication State
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);

  // Application State
  const [servers, setServers] = useState<Server[]>(MOCK_SERVERS);
  const [activeServerId, setActiveServerId] = useState<string>('s-dasideia');
  const [channels, setChannels] = useState<Channel[]>(MOCK_CHANNELS);
  const [activeChannelId, setActiveChannelId] = useState<string>('c-geral');
  const [messages, setMessages] = useState<Record<string, Message[]>>(INITIAL_MESSAGES);
  const [users, setUsers] = useState<User[]>(MOCK_USERS);
  const [currentUser, setCurrentUser] = useState<User>(CURRENT_USER);
  const [serverOnline, setServerOnline] = useState<boolean>(false);
  const [showVoiceStage, setShowVoiceStage] = useState<boolean>(false);

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
    screenShare: false,
    pingMs: 14,
    participants: [],
  });
  const mutedBeforeDeafenRef = useRef(false);

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
        version: '0.1.0',
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

  // Encerra a sessão local: sai da voz, desconecta o socket e volta para o login.
  // Não lê estado do componente, então é seguro chamar de dentro de listeners.
  const endSession = useCallback(() => {
    webrtcVoice.leave();
    setVoiceState((prev) => ({
      ...prev,
      connected: false,
      channelId: undefined,
      channelName: undefined,
      participants: [],
    }));
    setShowVoiceStage(false);
    realtimeSocket.setToken(null);
    clearLocalSession();
    setIsAuthenticated(false);
  }, []);

  // Aplica um usuário atualizado pelo servidor em todos os lugares onde ele aparece
  const applyUserUpdate = useCallback((updated: User) => {
    const merge = (u: User) => (u.id === updated.id ? { ...u, ...updated } : u);
    setCurrentUser(merge);
    setUsers((prev) => prev.map(merge));
    setActiveDMUser((prev) => (prev ? merge(prev) : prev));
    setFriendsSummary((prev) => ({
      friends: prev.friends.map(merge),
      incoming_requests: prev.incoming_requests.map((r) => ({ ...r, from_user: merge(r.from_user) })),
      outgoing_requests: prev.outgoing_requests.map((r) => ({ ...r, to_user: merge(r.to_user) })),
    }));

    const { token, user } = getLocalSession();
    if (token && user?.id === updated.id) {
      saveLocalSession(token, { ...user, ...updated });
    }
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
    });
    // O servidor recusou o token na conexão do WebSocket (ex: sessão expirou)
    const unsubAuthError = realtimeSocket.subscribeAuthError(endSession);

    const unsubMessages = realtimeSocket.subscribeMessages((event: SocketEvent) => {
      if (event.type === 'message' && event.data) {
        const incomingMsg: Message = withTimestamp(event.data);
        setMessages((prev) => ({
          ...prev,
          [event.channelId]: mergeMessages(prev[event.channelId] || [], [incomingMsg]),
        }));
      } else if (event.type === 'user-updated' && event.data) {
        // Perfil, avatar ou status mudou (seu, em outra sessão, ou de um amigo)
        applyUserUpdate(event.data as User);
      } else if (
        event.type === 'friend-request-received' ||
        event.type === 'friend-request-accepted'
      ) {
        refreshFriends();
      }
    });

    return () => {
      unsubStatus();
      unsubAuthError();
      unsubMessages();
    };
  }, [refreshFriends, endSession, applyUserUpdate]);

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

  const currentChannel: Channel = isDM
    ? {
        id: currentChannelId,
        serverId: 'home',
        name: activeDMUser!.name,
        type: 'text',
        topic: `Início do histórico de mensagens diretas com ${activeDMUser!.name} (${activeDMUser!.tag})`,
        category: 'MENSAGENS DIRETAS',
      }
    : channels.find((c) => c.id === activeChannelId) || channels[0];

  const currentMessages = messages[currentChannelId] || [];

  // Carrega o histórico salvo ao abrir um canal, e de novo ao reconectar (pega o que chegou offline)
  useEffect(() => {
    if (!isAuthenticated || !serverOnline) return;
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

  // Switch server
  const handleSelectServer = (serverId: string) => {
    setActiveServerId(serverId);
    if (serverId === 'home') {
      setActiveDMUser(null);
    } else {
      const serverChannels = channels.filter((c) => c.serverId === serverId);
      const firstTextChannel = serverChannels.find((c) => c.type === 'text') || serverChannels[0];
      if (firstTextChannel) {
        setActiveChannelId(firstTextChannel.id);
      }
    }
  };

  // Switch or interact with channel
  const handleSelectChannel = (channel: Channel) => {
    if (channel.type === 'voice') {
      if (!voiceState.connected || voiceState.channelId !== channel.id) {
        // Conecta no canal de voz WebRTC
        webrtcVoice.join(channel.id, currentUser, (participants) => {
          setVoiceState((prev) => ({ ...prev, participants }));
        });

        setVoiceState({
          connected: true,
          channelId: channel.id,
          channelName: channel.name,
          serverName: currentServer?.name,
          muted: voiceState.muted,
          deafened: voiceState.deafened,
          screenShare: false,
          pingMs: Math.floor(Math.random() * 8) + 12,
          participants: [
            {
              id: currentUser.id,
              name: currentUser.name,
              avatar: currentUser.avatar,
              speaking: false,
              muted: voiceState.muted,
              deafened: voiceState.deafened,
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
    webrtcVoice.setMuted(newMuted);
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
    webrtcVoice.setDeafened(newDeafened);
    webrtcVoice.setMuted(newMuted);
  };

  const handleDisconnectVoice = () => {
    webrtcVoice.leave();
    setVoiceState((prev) => ({
      ...prev,
      connected: false,
      channelId: undefined,
      channelName: undefined,
      participants: [],
    }));
    setShowVoiceStage(false);
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

  // Add Server simulation
  const handleAddServer = () => {
    const newId = `s-${Date.now()}`;
    const newServer: Server = {
      id: newId,
      name: `Novo Servidor ${servers.length + 1}`,
      initials: `S${servers.length + 1}`,
      gradient: 'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)',
    };
    const newChannels: Channel[] = [
      {
        id: `c-${newId}-geral`,
        serverId: newId,
        name: 'geral',
        type: 'text',
        topic: 'Canal inicial do novo servidor',
        category: 'TEXT CHANNELS',
      },
      {
        id: `c-${newId}-voz`,
        serverId: newId,
        name: '🔊 Bate-Papo',
        type: 'voice',
        category: 'VOICE CHANNELS',
      },
    ];

    setServers((prev) => [...prev, newServer]);
    setChannels((prev) => [...prev, ...newChannels]);
    setActiveServerId(newId);
    setActiveChannelId(`c-${newId}-geral`);
  };

  // Auth Handlers
  const handleLogin = (user: User) => {
    setCurrentUser(user);
    setUsers((prev) => [user, ...prev.filter((u) => u.id !== user.id)]);
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
    return <AuthScreen onLogin={handleLogin} />;
  }

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
          onAddServer={handleAddServer}
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
            onDisconnectVoice={handleDisconnectVoice}
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
            onToggleMute={handleToggleMute}
            onToggleDeafen={handleToggleDeafen}
            onDisconnectVoice={handleDisconnectVoice}
            onOpenSettings={(tab) => setSettingsTab(tab ?? 'account')}
            onChangePresence={handleChangePresence}
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
            onToggleMute={handleToggleMute}
            onToggleDeafen={handleToggleDeafen}
            onDisconnect={handleDisconnectVoice}
          />
        ) : (
          <ChatArea
            channel={currentChannel}
            messages={currentMessages}
            currentUser={currentUser}
            dmUser={activeServerId === 'home' && activeDMUser ? activeDMUser : undefined}
            onSendMessage={handleSendMessage}
            onToggleReaction={handleToggleReaction}
            showMemberList={showMemberList && activeServerId !== 'home'}
            onToggleMemberList={() => setShowMemberList(!showMemberList)}
          />
        )}

        {/* Right Member List (only shown when inside a server) */}
        {showMemberList && activeServerId !== 'home' && <MemberList users={users} />}
      </div>

      {/* Rust Performance & Memory Benchmark Modal */}
      {showStatsModal && (
        <RustStatsModal
          stats={stats}
          onClose={() => setShowStatsModal(false)}
          onRefresh={fetchStats}
        />
      )}

      {/* Configurações de usuário: Minha Conta, Perfil, Voz e Áudio */}
      {settingsTab && (
        <SettingsModal
          user={currentUser}
          initialTab={settingsTab}
          onClose={() => setSettingsTab(null)}
          onLogout={handleLogout}
          onUserUpdated={applyUserUpdate}
        />
      )}
    </div>
  );
}

export default App;

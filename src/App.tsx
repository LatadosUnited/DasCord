import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { ServerList } from './components/ServerList';
import { ChannelSidebar } from './components/ChannelSidebar';
import { ChannelDialog } from './components/servers/ChannelDialog';
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
import { UpdateBanner } from './components/UpdateBanner';
import { Channel, SettingsTab, User, UserStatus } from './types';
import { apiUpdatePresence } from './services/users';
import { apiLeaveServer } from './services/servers';
import { useSession } from './hooks/useSession';
import { useSocketStatus } from './hooks/useSocketStatus';
import { useVoice } from './hooks/useVoice';
import { VoiceLink, useServers } from './hooks/useServers';
import { useFriends } from './hooks/useFriends';
import { useMessages } from './hooks/useMessages';
import { useTyping } from './hooks/useTyping';
import { useRealtimeEvents } from './hooks/useRealtimeEvents';
import { useSystemStats } from './hooks/useSystemStats';
import { useServerVersion } from './hooks/useServerVersion';
import { useAppUpdate } from './hooks/useAppUpdate';
import './App.css';

/**
 * Monta o app a partir dos domínios: sessão, voz, servidores, amigos, mensagens.
 * Aqui só fica o que é de mais de um domínio ao mesmo tempo — o resto mora em src/hooks.
 */
export function App() {
  // A sessão pode cair sozinha antes de `endSession` existir; o ref fecha esse laço
  const endSessionRef = useRef<() => void>(() => {});
  const runEndSession = useCallback(() => endSessionRef.current(), []);

  const voice = useVoice();
  const voiceLink = useMemo<VoiceLink>(
    () => ({
      leaveIfInChannel: voice.leaveIfInChannel,
      getVoiceChannelId: voice.getVoiceChannelId,
      hideStage: voice.hideStage,
      loadServerRosters: voice.loadServerRosters,
    }),
    [voice.leaveIfInChannel, voice.getVoiceChannelId, voice.hideStage, voice.loadServerRosters]
  );

  const serverOnline = useSocketStatus(voice.clearRosters);
  const session = useSession(runEndSession);
  const { isAuthenticated, currentUser } = session;
  const servers = useServers({ isAuthenticated, serverOnline, voice: voiceLink });
  const friends = useFriends(isAuthenticated);

  const isDM = servers.activeServerId === 'home' && friends.activeDMUser !== null;
  // ID simétrico determinístico para que ambos os participantes vejam o mesmo canal de DM
  const currentChannelId = isDM
    ? `dm_${[currentUser.id, friends.activeDMUser!.id].sort().join('_')}`
    : servers.activeChannelId;

  const messages = useMessages({
    channelId: currentChannelId,
    currentUser,
    isAuthenticated,
    serverOnline,
  });
  const typing = useTyping(currentChannelId);

  const { stats, refresh: refreshStats } = useSystemStats();
  const serverVersion = useServerVersion(serverOnline);
  const appUpdate = useAppUpdate();

  // UI Panels & Modals
  const [showMemberList, setShowMemberList] = useState(true);
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);

  // Encerra a sessão: sai da voz, desconecta o socket e esquece tudo da conta anterior,
  // que não pode aparecer para quem entrar depois.
  const endSession = useCallback(() => {
    voice.reset();
    session.signOut();
    servers.reset();
    messages.reset();
    friends.reset();
  }, [voice.reset, session.signOut, servers.reset, messages.reset, friends.reset]);
  useEffect(() => {
    endSessionRef.current = endSession;
  }, [endSession]);

  /** Um usuário mudou: aplica em todos os lugares onde ele aparece */
  const applyUserUpdate = useCallback(
    (updated: User) => {
      session.applyUserUpdate(updated);
      friends.applyUserUpdate(updated);
      servers.applyUserUpdate(updated);
    },
    [session.applyUserUpdate, friends.applyUserUpdate, servers.applyUserUpdate]
  );

  useRealtimeEvents({
    onAuthError: endSession,
    isSelf: (userId) => userId === session.getCurrentUserId(),
    onVoiceEvent: voice.applyRosterEvent,
    onMessage: (channelId, message) => {
      const saved = messages.receive(channelId, message);
      typing.clearFor(channelId, saved.author.id);
    },
    onMessageUpdated: messages.applyUpdate,
    onMessageDeleted: messages.applyDelete,
    onReaction: messages.applyReactionEvent,
    onTyping: typing.remoteTyping,
    onUserUpdated: applyUserUpdate,
    onFriendshipChanged: friends.refresh,
    onSelfJoinedServer: servers.loadServers,
    onMemberJoined: servers.upsertMember,
    onSelfLeftServer: servers.removeServerLocally,
    onMemberLeft: servers.removeMember,
    onServerUpdated: servers.upsertServer,
    onServerDeleted: servers.removeServerLocally,
    onChannelDeleted: servers.removeChannelLocally,
  });

  const handleSelectServer = (serverId: string) => {
    if (serverId === 'home') friends.setActiveDMUser(null);
    servers.selectServer(serverId);
  };

  const handleSelectChannel = (channel: Channel) => {
    if (channel.type === 'voice') {
      voice.enterOrToggleStage(channel, currentUser, servers.currentServer?.name);
    } else {
      servers.selectTextChannel(channel);
    }
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

  if (!isAuthenticated) {
    return (
      <>
        <AuthScreen onLogin={session.signIn} />
        <VersionBanner serverVersion={serverVersion} />
        <UpdateBanner state={appUpdate} />
      </>
    );
  }

  const { currentServer, currentServerChannels, serverDialog, channelDialog } = servers;
  const currentChannel: Channel | undefined = isDM
    ? {
        id: currentChannelId,
        serverId: 'home',
        name: friends.activeDMUser!.name,
        type: 'text',
        topic: `Início do histórico de mensagens diretas com ${friends.activeDMUser!.name} (${friends.activeDMUser!.tag})`,
        category: 'MENSAGENS DIRETAS',
      }
    : currentServerChannels.find((c) => c.id === servers.activeChannelId && c.type === 'text');

  const closeServerDialog = () => servers.setServerDialog(null);
  const dialogServer =
    serverDialog && 'serverId' in serverDialog
      ? servers.servers.find((s) => s.id === serverDialog.serverId)
      : undefined;

  return (
    <div className="app-container">
      {/* Window Native Titlebar with Rust Benchmark Badge */}
      <TitleBar
        stats={stats}
        serverOnline={serverOnline}
        onOpenStats={() => setShowStatsModal(true)}
        onLogout={session.requestLogout}
      />

      {/* Main App Grid */}
      <div className="main-layout">
        {/* Leftmost Guilds/Servers Rail */}
        <ServerList
          servers={servers.servers}
          activeServerId={servers.activeServerId}
          onSelectServer={handleSelectServer}
          onAddServer={() => servers.setServerDialog({ kind: 'add' })}
        />

        {/* Channels Sidebar or Direct Messages Sidebar */}
        {servers.activeServerId === 'home' ? (
          <DMSidebar
            currentUser={currentUser}
            friends={friends.summary.friends}
            pendingRequestsCount={friends.summary.incoming_requests.length}
            activeDMUserId={friends.activeDMUser ? friends.activeDMUser.id : null}
            onSelectFriendsHub={() => friends.setActiveDMUser(null)}
            onSelectFriendDM={(friend) => friends.setActiveDMUser(friend)}
            voiceState={voice.voiceState}
            onToggleMute={voice.toggleMute}
            onToggleDeafen={voice.toggleDeafen}
            onDisconnectVoice={voice.leave}
            onOpenSettings={(tab) => setSettingsTab(tab ?? 'account')}
            onChangePresence={handleChangePresence}
          />
        ) : (
          <ChannelSidebar
            server={currentServer}
            channels={currentServerChannels}
            activeChannelId={servers.activeChannelId}
            onSelectChannel={handleSelectChannel}
            currentUser={currentUser}
            voiceState={voice.voiceState}
            voiceRosters={voice.voiceRosters}
            onToggleMute={voice.toggleMute}
            onToggleDeafen={voice.toggleDeafen}
            onDisconnectVoice={voice.leave}
            onOpenSettings={(tab) => setSettingsTab(tab ?? 'account')}
            onChangePresence={handleChangePresence}
            onInvite={() =>
              servers.setServerDialog({ kind: 'invite', serverId: servers.activeServerId })
            }
            onOpenServerSettings={() =>
              servers.setServerDialog({ kind: 'settings', serverId: servers.activeServerId })
            }
            onLeaveServer={() =>
              servers.setServerDialog({ kind: 'leave', serverId: servers.activeServerId })
            }
            isOwner={!!currentServer?.ownerId && currentServer.ownerId === currentUser.id}
            onCreateChannel={(category) => servers.setChannelDialog({ mode: 'create', category })}
            onEditChannel={(channel) => servers.setChannelDialog({ mode: 'edit', channel })}
            onDeleteChannel={(channel) => servers.setChannelDialog({ mode: 'delete', channel })}
          />
        )}

        {/* Main Central View: FriendsHub, Voice Stage, or Chat Area */}
        {servers.activeServerId === 'home' && friends.activeDMUser === null ? (
          <FriendsHub
            summary={friends.summary}
            currentUser={currentUser}
            onRefresh={friends.refresh}
            onOpenDM={(friend) => friends.setActiveDMUser(friend)}
          />
        ) : voice.showVoiceStage && voice.voiceState.connected ? (
          <VoiceStage
            channelName={voice.voiceState.channelName || 'Canal de Voz'}
            voiceState={voice.voiceState}
            participants={voice.voiceState.participants}
            currentUserId={currentUser.id}
            onToggleMute={voice.toggleMute}
            onToggleDeafen={voice.toggleDeafen}
            onDisconnect={voice.leave}
          />
        ) : currentChannel ? (
          <ChatArea
            channel={currentChannel}
            messages={messages.messages}
            currentUser={currentUser}
            dmUser={isDM ? friends.activeDMUser! : undefined}
            onSendMessage={messages.send}
            onToggleReaction={messages.toggleReaction}
            onEditMessage={messages.edit}
            onDeleteMessage={messages.remove}
            onTyping={typing.notifyTyping}
            typingNames={typing.typingNames}
            canModerate={currentServer?.ownerId === currentUser.id}
            showMemberList={showMemberList && servers.activeServerId !== 'home'}
            onToggleMemberList={() => setShowMemberList(!showMemberList)}
          />
        ) : (
          <div className="main-placeholder">
            {serverOnline ? 'Escolha um canal de texto para conversar.' : 'Conectando ao servidor...'}
          </div>
        )}

        {/* Right Member List (only shown when inside a server) */}
        {showMemberList && currentServer && (
          <MemberList members={servers.members[currentServer.id]} ownerId={currentServer.ownerId} />
        )}
      </div>

      {/* Rust Performance & Memory Benchmark Modal */}
      {showStatsModal && (
        <RustStatsModal
          stats={stats}
          serverVersion={serverVersion?.version ?? null}
          onClose={() => setShowStatsModal(false)}
          onRefresh={refreshStats}
        />
      )}

      {/* Configurações de usuário: Minha Conta, Perfil, Voz e Áudio */}
      {settingsTab && (
        <SettingsModal
          user={currentUser}
          initialTab={settingsTab}
          serverVersion={serverVersion?.version ?? null}
          onClose={() => setSettingsTab(null)}
          onLogout={session.requestLogout}
          onUserUpdated={applyUserUpdate}
        />
      )}

      <VersionBanner serverVersion={serverVersion} />
      <UpdateBanner state={appUpdate} />

      {channelDialog && currentServer && (
        <ChannelDialog
          mode={channelDialog.mode}
          serverId={currentServer.id}
          channel={channelDialog.channel}
          defaultCategory={channelDialog.category}
          categories={[...new Set(currentServerChannels.map((c) => c.category))]}
          onDone={(dto) => {
            servers.upsertServer(dto);
            servers.setChannelDialog(null);
          }}
          onClose={() => servers.setChannelDialog(null)}
        />
      )}

      {/* Servidores: adicionar, convidar, configurar e sair */}
      {serverDialog?.kind === 'add' && (
        <AddServerModal
          currentUser={currentUser}
          onClose={closeServerDialog}
          onServerReady={(dto) => {
            servers.upsertServer(dto);
            servers.openServer(dto.id, dto.channels);
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
          onServerUpdated={servers.upsertServer}
          onDeleted={servers.removeServerLocally}
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
            servers.removeServerLocally(dialogServer.id);
            return null;
          }}
          onClose={closeServerDialog}
        />
      )}
    </div>
  );
}

export default App;

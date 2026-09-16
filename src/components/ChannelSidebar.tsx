import { FC, useEffect, useRef, useState } from 'react';
import { Hash, Volume2, ChevronDown, MicOff, X } from 'lucide-react';
import { Channel, Server, SettingsTab, User, UserStatus, VoiceState } from '../types';
import { VoiceConnectionBar } from './VoiceConnectionBar';
import { UserPanel } from './UserPanel';
import { ServerMenu } from './servers/ServerMenu';
import { VoiceRosters } from '../services/voiceRoster';
import './sidebar.css';
import './ChannelSidebar.css';

interface ChannelSidebarProps {
  server: Server | undefined;
  channels: Channel[];
  activeChannelId: string;
  onSelectChannel: (channel: Channel) => void;
  currentUser: User;
  voiceState: VoiceState;
  /** Participantes de cada canal de voz, vistos de fora da chamada */
  voiceRosters: VoiceRosters;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onDisconnectVoice: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onChangePresence: (status: UserStatus, customStatus: string) => void;
  onInvite: () => void;
  onOpenServerSettings: () => void;
  onLeaveServer: () => void;
}

export const ChannelSidebar: FC<ChannelSidebarProps> = ({
  server,
  channels,
  activeChannelId,
  onSelectChannel,
  currentUser,
  voiceState,
  voiceRosters,
  onToggleMute,
  onToggleDeafen,
  onDisconnectVoice,
  onOpenSettings,
  onChangePresence,
  onInvite,
  onOpenServerSettings,
  onLeaveServer,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);

  // Fecha o menu ao clicar fora, apertar Esc ou trocar de servidor
  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => setMenuOpen(false), [server?.id]);

  // Agrupar canais por categoria
  const categories = Array.from(new Set(channels.map((c) => c.category)));

  return (
    <div className="channel-sidebar">
      <div className="server-header-wrapper" ref={headerRef}>
        <button
          className={`server-header server-header-button ${menuOpen ? 'active' : ''}`}
          onClick={() => server && setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={!server}
        >
          <span className="server-name">{server ? server.name : 'Carregando...'}</span>
          {menuOpen ? (
            <X size={18} className="server-header-icon" />
          ) : (
            <ChevronDown size={18} className="server-header-icon" />
          )}
        </button>
        {menuOpen && server && (
          <ServerMenu
            server={server}
            currentUser={currentUser}
            onInvite={onInvite}
            onOpenSettings={onOpenServerSettings}
            onLeave={onLeaveServer}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>

      <div className="channels-scroll">
        {categories.map((cat) => (
          <div key={cat} className="channel-group">
            <div className="channel-category">
              <span>{cat}</span>
            </div>

            {channels
              .filter((c) => c.category === cat)
              .map((channel) => {
                const isActive = activeChannelId === channel.id;
                const isVoiceActive = voiceState.connected && voiceState.channelId === channel.id;
                // Dentro da chamada vale o estado local (fala sem atraso); fora, o que o servidor contou
                const voiceParticipants =
                  channel.type !== 'voice'
                    ? []
                    : isVoiceActive
                      ? voiceState.participants
                      : voiceRosters[channel.id] ?? [];

                return (
                  <div key={channel.id}>
                    <div
                      className={`channel-item ${isActive ? 'active' : ''} ${channel.unread ? 'unread' : ''}`}
                      onClick={() => onSelectChannel(channel)}
                    >
                      {channel.type === 'text' ? (
                        <Hash size={18} className="channel-icon" />
                      ) : (
                        <Volume2 size={18} className={`channel-icon ${isVoiceActive ? 'voice-live' : ''}`} />
                      )}
                      <span className="channel-name">{channel.name}</span>
                    </div>

                    {voiceParticipants.length > 0 && (
                      <div className="voice-channel-members">
                        {voiceParticipants.map((p) => (
                          <div
                            key={p.id}
                            className={`voice-member-item ${
                              p.connection === 'reconnecting' || p.connection === 'failed' ? 'unstable' : ''
                            }`}
                            title={
                              p.connection === 'reconnecting'
                                ? 'Reconectando...'
                                : p.connection === 'failed'
                                  ? 'Sem conexão'
                                  : undefined
                            }
                          >
                            <div className="voice-member-avatar-wrapper">
                              <img
                                src={p.avatar}
                                alt={p.name}
                                className={`voice-member-avatar speaking-avatar ${p.speaking ? 'is-speaking' : ''}`}
                              />
                            </div>
                            <span className="voice-member-name">{p.name}</span>
                            {p.streaming && <span className="live-badge">AO VIVO</span>}
                            {p.muted && <MicOff size={12} className="voice-member-muted" />}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        ))}
      </div>

      <VoiceConnectionBar voiceState={voiceState} onDisconnect={onDisconnectVoice} />

      <UserPanel
        currentUser={currentUser}
        voiceState={voiceState}
        onToggleMute={onToggleMute}
        onToggleDeafen={onToggleDeafen}
        onOpenSettings={onOpenSettings}
        onChangePresence={onChangePresence}
      />
    </div>
  );
};

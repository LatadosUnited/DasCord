import { FC } from 'react';
import { Hash, Volume2, ChevronDown, MicOff, Plus } from 'lucide-react';
import { Channel, Server, SettingsTab, User, UserStatus, VoiceState } from '../types';
import { VoiceConnectionBar } from './VoiceConnectionBar';
import { UserPanel } from './UserPanel';

interface ChannelSidebarProps {
  server: Server | undefined;
  channels: Channel[];
  activeChannelId: string;
  onSelectChannel: (channel: Channel) => void;
  currentUser: User;
  voiceState: VoiceState;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onDisconnectVoice: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onChangePresence: (status: UserStatus, customStatus: string) => void;
}

export const ChannelSidebar: FC<ChannelSidebarProps> = ({
  server,
  channels,
  activeChannelId,
  onSelectChannel,
  currentUser,
  voiceState,
  onToggleMute,
  onToggleDeafen,
  onDisconnectVoice,
  onOpenSettings,
  onChangePresence,
}) => {
  // Agrupar canais por categoria
  const categories = Array.from(new Set(channels.map((c) => c.category)));

  return (
    <div className="channel-sidebar">
      {/* Server Header */}
      <div className="server-header">
        <span className="server-name">{server ? server.name : 'Mensagens Diretas'}</span>
        <ChevronDown size={18} color="#949ba4" />
      </div>

      {/* Channels List */}
      <div className="channels-scroll">
        {categories.map((cat) => (
          <div key={cat} style={{ marginBottom: '10px' }}>
            <div className="channel-category">
              <span>{cat}</span>
              <Plus size={14} style={{ cursor: 'pointer' }} />
            </div>

            {channels
              .filter((c) => c.category === cat)
              .map((channel) => {
                const isActive = activeChannelId === channel.id;
                const isVoiceActive = voiceState.connected && voiceState.channelId === channel.id;

                return (
                  <div key={channel.id}>
                    <div
                      className={`channel-item ${isActive ? 'active' : ''} ${
                        channel.unread ? 'unread' : ''
                      }`}
                      onClick={() => onSelectChannel(channel)}
                    >
                      {channel.type === 'text' ? (
                        <Hash size={18} className="channel-icon" />
                      ) : (
                        <Volume2
                          size={18}
                          className="channel-icon"
                          color={isVoiceActive ? '#23a55a' : undefined}
                        />
                      )}
                      <span style={{ flex: 1 }}>{channel.name}</span>
                    </div>

                    {/* Members connected in this voice channel */}
                    {isVoiceActive && voiceState.participants && voiceState.participants.length > 0 && (
                      <div className="voice-channel-members">
                        {voiceState.participants.map((p) => (
                          <div key={p.id} className="voice-member-item">
                            <div className="voice-member-avatar-wrapper">
                              <img
                                src={p.avatar}
                                alt={p.name}
                                className={`voice-member-avatar speaking-avatar ${
                                  p.speaking ? 'is-speaking' : ''
                                }`}
                              />
                            </div>
                            <span className="voice-member-name">{p.name}</span>
                            {p.muted && <MicOff size={12} color="#f23f43" />}
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

      {/* Voice Status bar if in call */}
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

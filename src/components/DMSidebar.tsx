import { FC } from 'react';
import { Users, Sparkles, Plus, X } from 'lucide-react';
import { SettingsTab, User, UserStatus, VoiceState } from '../types';
import { VoiceConnectionBar } from './VoiceConnectionBar';
import { UserPanel } from './UserPanel';

interface DMSidebarProps {
  currentUser: User;
  friends: User[];
  pendingRequestsCount: number;
  activeDMUserId: string | null;
  onSelectFriendsHub: () => void;
  onSelectFriendDM: (friend: User) => void;
  voiceState: VoiceState;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onDisconnectVoice: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onChangePresence: (status: UserStatus, customStatus: string) => void;
}

export const DMSidebar: FC<DMSidebarProps> = ({
  currentUser,
  friends,
  pendingRequestsCount,
  activeDMUserId,
  onSelectFriendsHub,
  onSelectFriendDM,
  voiceState,
  onToggleMute,
  onToggleDeafen,
  onDisconnectVoice,
  onOpenSettings,
  onChangePresence,
}) => {
  return (
    <div className="channel-sidebar dm-sidebar">
      {/* Search Header */}
      <div className="server-header dm-search-header">
        <button className="dm-search-bar-btn" onClick={onSelectFriendsHub}>
          <span>Encontre ou comece uma conversa</span>
        </button>
      </div>

      <div className="channels-scroll">
        {/* Navigation Items */}
        <div className="dm-nav-group">
          <div
            className={`dm-nav-item ${activeDMUserId === null ? 'active' : ''}`}
            onClick={onSelectFriendsHub}
          >
            <div className="dm-nav-icon">
              <Users size={20} />
            </div>
            <span className="dm-nav-label">Amigos</span>
            {pendingRequestsCount > 0 && (
              <span className="dm-badge">{pendingRequestsCount}</span>
            )}
          </div>

          <div className="dm-nav-item">
            <div className="dm-nav-icon">
              <Sparkles size={20} color="#eb459e" />
            </div>
            <span className="dm-nav-label">Nitro</span>
          </div>
        </div>

        {/* DMs Header */}
        <div className="channel-category dm-category-header">
          <span>MENSAGENS DIRETAS</span>
          <button
            className="dm-add-icon-btn"
            onClick={onSelectFriendsHub}
            title="Criar mensagem direta"
            style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
          >
            <Plus size={14} className="dm-add-icon" />
          </button>
        </div>

        {/* DM User List */}
        <div className="dm-conversations-list">
          {friends.length === 0 ? (
            <div className="dm-empty-hint" onClick={onSelectFriendsHub}>
              <span>Nenhuma conversa ainda. Adicione um amigo!</span>
            </div>
          ) : (
            friends.map((friend) => {
              const isActive = activeDMUserId === friend.id;
              return (
                <div
                  key={friend.id}
                  className={`dm-conversation-item ${isActive ? 'active' : ''}`}
                  onClick={() => onSelectFriendDM(friend)}
                >
                  <div className="avatar-wrapper dm-avatar">
                    <img
                      src={friend.avatar}
                      alt={friend.name}
                      className="avatar-img"
                    />
                    <div className={`status-dot ${friend.status}`} />
                  </div>
                  <div className="dm-item-info">
                    <span className="dm-user-name">{friend.name}</span>
                    <span className="dm-user-tag">{friend.tag}</span>
                  </div>
                  <button
                    className="dm-close-btn"
                    title="Fechar DM"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (activeDMUserId === friend.id) {
                        onSelectFriendsHub();
                      }
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Voice Status bar if in call */}
      <VoiceConnectionBar
        voiceState={voiceState}
        onDisconnect={onDisconnectVoice}
      />

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

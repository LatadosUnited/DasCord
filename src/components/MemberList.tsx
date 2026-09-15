import { FC } from 'react';
import { User } from '../types';

interface MemberListProps {
  users: User[];
}

export const MemberList: FC<MemberListProps> = ({ users }) => {
  const onlineUsers = users.filter((u) => u.status === 'online');
  const idleOrDnd = users.filter((u) => u.status === 'idle' || u.status === 'dnd');
  const offlineUsers = users.filter((u) => u.status === 'offline');

  const renderUser = (user: User) => (
    <div key={user.id} className="member-card">
      <div className="avatar-wrapper">
        <img src={user.avatar} alt={user.name} className="avatar-img" />
        <div className={`status-dot ${user.status}`} />
      </div>
      <div className="member-info">
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span className="member-name" style={{ color: user.roleColor }}>
            {user.name}
          </span>
          {user.isBot && <span className="bot-tag">BOT</span>}
        </div>
        {user.customStatus && <span className="member-status">{user.customStatus}</span>}
      </div>
    </div>
  );

  return (
    <div className="member-list">
      {/* Online Users */}
      <div className="member-group-title">ONLINE — {onlineUsers.length}</div>
      {onlineUsers.map(renderUser)}

      {/* Away / DND */}
      {idleOrDnd.length > 0 && (
        <>
          <div className="member-group-title" style={{ marginTop: '16px' }}>
            AUSENTE / OCUPADO — {idleOrDnd.length}
          </div>
          {idleOrDnd.map(renderUser)}
        </>
      )}

      {/* Offline */}
      {offlineUsers.length > 0 && (
        <>
          <div className="member-group-title" style={{ marginTop: '16px' }}>
            OFFLINE — {offlineUsers.length}
          </div>
          {offlineUsers.map(renderUser)}
        </>
      )}
    </div>
  );
};

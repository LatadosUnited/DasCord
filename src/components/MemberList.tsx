import { FC } from 'react';
import { Crown } from 'lucide-react';
import { User } from '../types';
import './MemberList.css';

interface MemberListProps {
  /** undefined enquanto a lista ainda não chegou do servidor */
  members: User[] | undefined;
  ownerId: string | null | undefined;
}

const byName = (a: User, b: User) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });

export const MemberList: FC<MemberListProps> = ({ members, ownerId }) => {
  if (!members) {
    return (
      <div className="member-list">
        <div className="member-group-title">Carregando membros...</div>
      </div>
    );
  }

  const onlineUsers = members.filter((u) => u.status === 'online').sort(byName);
  const idleOrDnd = members.filter((u) => u.status === 'idle' || u.status === 'dnd').sort(byName);
  const offlineUsers = members.filter((u) => u.status === 'offline').sort(byName);

  const renderUser = (user: User) => (
    <div key={user.id} className={`member-card ${user.status === 'offline' ? 'offline' : ''}`}>
      <div className="avatar-wrapper">
        <img src={user.avatar} alt={user.name} className="avatar-img" />
        <div className={`status-dot ${user.status}`} />
      </div>
      <div className="member-info">
        <div className="member-name-row">
          {/* A cor do cargo é um dado do usuário */}
          <span className="member-name" style={{ color: user.roleColor }}>
            {user.name}
          </span>
          {user.id === ownerId && (
            <span className="member-owner" title="Dono do servidor">
              <Crown size={13} />
            </span>
          )}
          {user.isBot && <span className="bot-tag">BOT</span>}
        </div>
        {user.customStatus && <span className="member-status">{user.customStatus}</span>}
      </div>
    </div>
  );

  return (
    <div className="member-list">
      <div className="member-group-title">Online — {onlineUsers.length}</div>
      {onlineUsers.map(renderUser)}

      {idleOrDnd.length > 0 && (
        <>
          <div className="member-group-title spaced">Ausente / ocupado — {idleOrDnd.length}</div>
          {idleOrDnd.map(renderUser)}
        </>
      )}

      {offlineUsers.length > 0 && (
        <>
          <div className="member-group-title spaced">Offline — {offlineUsers.length}</div>
          {offlineUsers.map(renderUser)}
        </>
      )}
    </div>
  );
};

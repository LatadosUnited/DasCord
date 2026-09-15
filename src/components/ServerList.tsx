import { FC } from 'react';
import { MessageSquare, Plus, Compass } from 'lucide-react';
import { Server } from '../types';

interface ServerListProps {
  servers: Server[];
  activeServerId: string;
  onSelectServer: (serverId: string) => void;
  onAddServer: () => void;
}

export const ServerList: FC<ServerListProps> = ({
  servers,
  activeServerId,
  onSelectServer,
  onAddServer,
}) => {
  return (
    <div className="server-list">
      {/* Direct Messages Home Button */}
      <div
        className={`server-item-wrapper ${activeServerId === 'home' ? 'active' : ''}`}
        onClick={() => onSelectServer('home')}
        title="Mensagens Diretas"
      >
        <div className="server-pill" />
        <div className="server-icon discord-home">
          <MessageSquare size={24} />
        </div>
      </div>

      <div className="server-separator" />

      {/* Servers */}
      {servers.map((server) => {
        const isActive = activeServerId === server.id;
        return (
          <div
            key={server.id}
            className={`server-item-wrapper ${isActive ? 'active' : ''}`}
            onClick={() => onSelectServer(server.id)}
            title={server.name}
          >
            <div className="server-pill" />
            <div
              className="server-icon"
              style={{
                background: server.gradient,
              }}
            >
              <span>{server.initials}</span>
              {server.unreadCount && server.unreadCount > 0 && (
                <div className="server-badge">
                  {server.unreadCount > 99 ? '99+' : server.unreadCount}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Add Server & Explore buttons */}
      <div className="server-item-wrapper">
        <button
          className="server-action-btn"
          onClick={onAddServer}
          title="Adicionar um Servidor"
        >
          <Plus size={22} />
        </button>
      </div>

      <div className="server-item-wrapper">
        <button
          className="server-action-btn"
          title="Explorar Servidores Públicos"
          style={{ color: '#22d3ee' }}
        >
          <Compass size={22} />
        </button>
      </div>
    </div>
  );
};

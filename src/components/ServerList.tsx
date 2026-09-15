import { FC } from 'react';
import { Lightbulb, Plus } from 'lucide-react';
import { Server } from '../types';
import './ServerList.css';

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
      {/* Início: amigos e mensagens diretas */}
      <div
        className={`server-item-wrapper ${activeServerId === 'home' ? 'active' : ''}`}
        onClick={() => onSelectServer('home')}
        title="Mensagens Diretas"
      >
        <div className="server-pill" />
        <div className="server-icon home-icon">
          <Lightbulb size={24} strokeWidth={2.25} />
        </div>
      </div>

      <div className="server-separator" />

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
            {/* Sem ícone enviado, o degradê (derivado do ID) é um dado de cada servidor */}
            <div className="server-icon" style={server.icon ? undefined : { background: server.gradient }}>
              {server.icon ? (
                <img src={server.icon} alt={server.name} className="server-icon-image" />
              ) : (
                <span>{server.initials}</span>
              )}
              {!!server.unreadCount && (
                <div className="server-badge">{server.unreadCount > 99 ? '99+' : server.unreadCount}</div>
              )}
            </div>
          </div>
        );
      })}

      <div className="server-item-wrapper">
        <button className="server-action-btn add" onClick={onAddServer} title="Adicionar um servidor">
          <Plus size={22} />
        </button>
      </div>
    </div>
  );
};

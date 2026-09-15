import { FC } from 'react';
import { LogOut, Settings, UserPlus } from 'lucide-react';
import { Server, User } from '../../types';
import './servers.css';

interface ServerMenuProps {
  server: Server;
  currentUser: User;
  onInvite: () => void;
  onOpenSettings: () => void;
  onLeave: () => void;
  onClose: () => void;
}

/** Menu que abre pelo nome do servidor, no topo da barra de canais */
export const ServerMenu: FC<ServerMenuProps> = ({ server, currentUser, onInvite, onOpenSettings, onLeave, onClose }) => {
  const isOwner = server.ownerId === currentUser.id;

  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <div className="popover-menu server-menu" role="menu">
      <div className="popover-section">
        <button className="popover-item accent" role="menuitem" onClick={run(onInvite)}>
          <span className="popover-item-label">Convidar pessoas</span>
          <UserPlus size={16} />
        </button>
        {isOwner && (
          <button className="popover-item" role="menuitem" onClick={run(onOpenSettings)}>
            <span className="popover-item-label">Configurações do servidor</span>
            <Settings size={16} />
          </button>
        )}
      </div>

      {!isOwner && (
        <>
          <div className="popover-divider" />
          <div className="popover-section">
            <button className="popover-item danger" role="menuitem" onClick={run(onLeave)}>
              <span className="popover-item-label">Sair do servidor</span>
              <LogOut size={16} />
            </button>
          </div>
        </>
      )}
    </div>
  );
};

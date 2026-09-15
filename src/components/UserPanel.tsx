import { FC, useEffect, useRef, useState } from 'react';
import { ChevronDown, Headphones, Mic, MicOff, Settings } from 'lucide-react';
import { SettingsTab, User, UserStatus, VoiceState } from '../types';
import { statusLabel } from '../services/presence';
import { StatusMenu } from './StatusMenu';
import { DeviceMenu } from './DeviceMenu';
import './UserPanel.css';

interface UserPanelProps {
  currentUser: User;
  voiceState: VoiceState;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onChangePresence: (status: UserStatus, customStatus: string) => void;
}

type OpenMenu = 'status' | 'input' | 'output' | null;

/** Rodapé com o usuário logado: status, microfone, fone e configurações */
export const UserPanel: FC<UserPanelProps> = ({
  currentUser,
  voiceState,
  onToggleMute,
  onToggleDeafen,
  onOpenSettings,
  onChangePresence,
}) => {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Fecha o menu ao clicar fora ou apertar Esc
  useEffect(() => {
    if (!openMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  const toggle = (menu: Exclude<OpenMenu, null>) => setOpenMenu((prev) => (prev === menu ? null : menu));
  const close = () => setOpenMenu(null);

  return (
    <div className="user-panel" ref={panelRef}>
      {openMenu === 'status' && (
        <StatusMenu
          user={currentUser}
          onChange={onChangePresence}
          onEditProfile={() => onOpenSettings('profile')}
          onClose={close}
        />
      )}
      {(openMenu === 'input' || openMenu === 'output') && (
        <DeviceMenu kind={openMenu} onOpenVoiceSettings={() => onOpenSettings('voice')} onClose={close} />
      )}

      <button
        className={`user-info ${openMenu === 'status' ? 'active' : ''}`}
        onClick={() => toggle('status')}
        title="Definir status"
      >
        <div className="avatar-wrapper">
          <img src={currentUser.avatar} alt={currentUser.name} className="avatar-img" />
          <div className={`status-dot ${currentUser.status}`} />
        </div>
        <div className="user-names">
          <span className="user-display-name">{currentUser.name}</span>
          <span className="user-subtext">{currentUser.customStatus || statusLabel(currentUser.status)}</span>
        </div>
      </button>

      <div className="user-actions">
        <div className={`user-action-split ${openMenu === 'input' ? 'active' : ''}`}>
          <button
            className={`user-action-icon ${voiceState.muted ? 'danger' : ''}`}
            onClick={onToggleMute}
            title={voiceState.muted ? 'Desativar mudo' : 'Silenciar'}
          >
            {voiceState.muted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
          <button className="user-action-chevron" onClick={() => toggle('input')} title="Opções de entrada">
            <ChevronDown size={14} />
          </button>
        </div>

        <div className={`user-action-split ${openMenu === 'output' ? 'active' : ''}`}>
          <button
            className={`user-action-icon ${voiceState.deafened ? 'danger' : ''}`}
            onClick={onToggleDeafen}
            title={voiceState.deafened ? 'Ativar som' : 'Ensurdecer'}
          >
            <Headphones size={18} />
          </button>
          <button className="user-action-chevron" onClick={() => toggle('output')} title="Opções de saída">
            <ChevronDown size={14} />
          </button>
        </div>

        <button className="user-action-icon" onClick={() => onOpenSettings()} title="Configurações de usuário">
          <Settings size={18} />
        </button>
      </div>
    </div>
  );
};

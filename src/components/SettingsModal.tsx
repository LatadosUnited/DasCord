import { FC, useEffect, useState } from 'react';
import { Mic, Palette, User as UserIcon, X } from 'lucide-react';
import { SettingsTab, User } from '../types';
import { AccountTab } from './settings/AccountTab';
import { ProfileTab } from './settings/ProfileTab';
import { VoiceTab } from './settings/VoiceTab';
import './settings/settings.css';

interface SettingsModalProps {
  user: User;
  initialTab: SettingsTab;
  onClose: () => void;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

const TABS: { id: SettingsTab; label: string; icon: typeof UserIcon }[] = [
  { id: 'account', label: 'Minha Conta', icon: UserIcon },
  { id: 'profile', label: 'Perfil', icon: Palette },
  { id: 'voice', label: 'Voz e Áudio', icon: Mic },
];

export const SettingsModal: FC<SettingsModalProps> = ({ user, initialTab, onClose, onLogout, onUserUpdated }) => {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  // Incrementado quando o usuário tenta sair com alterações não salvas: a barra de aviso chacoalha
  const [attention, setAttention] = useState(0);

  const guardedClose = () => {
    if (hasUnsavedChanges) {
      setAttention((n) => n + 1);
      return;
    }
    onClose();
  };

  const guardedTabChange = (next: SettingsTab) => {
    if (next === tab) return;
    if (hasUnsavedChanges) {
      setAttention((n) => n + 1);
      return;
    }
    setTab(next);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') guardedClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  return (
    <div className="modal-overlay" onMouseDown={guardedClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Configurações de usuário"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <span className="settings-title">Configurações de usuário</span>
          <button className="icon-btn" onClick={guardedClose} title="Fechar (Esc)">
            <X size={20} />
          </button>
        </header>

        <nav className="settings-tabs" role="tablist">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`settings-tab ${tab === id ? 'active' : ''}`}
              onClick={() => guardedTabChange(id)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-body">
          {tab === 'account' && <AccountTab user={user} onLogout={onLogout} onClose={onClose} />}
          {tab === 'profile' && (
            <ProfileTab
              user={user}
              onUserUpdated={onUserUpdated}
              onDirtyChange={setHasUnsavedChanges}
              attentionSignal={attention}
            />
          )}
          {tab === 'voice' && <VoiceTab />}
        </div>
      </div>
    </div>
  );
};

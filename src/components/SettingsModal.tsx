import { FC, useEffect, useState } from 'react';
import { LogOut, Mic, Palette, User as UserIcon, X } from 'lucide-react';
import { SettingsTab, User } from '../types';
import { AccountTab } from './settings/AccountTab';
import { ProfileTab } from './settings/ProfileTab';
import { VoiceTab } from './settings/VoiceTab';
import { APP_VERSION } from '../services/version';
import './settings/settings.css';

interface SettingsModalProps {
  user: User;
  initialTab: SettingsTab;
  /** null: servidor offline ou anterior à 0.2.0 */
  serverVersion: string | null;
  onClose: () => void;
  onLogout: () => void;
  onUserUpdated: (user: User) => void;
}

interface TabInfo {
  id: SettingsTab;
  label: string;
  icon: typeof UserIcon;
}

/** Os assuntos em grupos, como no Discord: primeiro a pessoa, depois o app */
const GROUPS: { title: string; tabs: TabInfo[] }[] = [
  {
    title: 'Configurações do usuário',
    tabs: [
      { id: 'account', label: 'Minha Conta', icon: UserIcon },
      { id: 'profile', label: 'Perfil', icon: Palette },
    ],
  },
  {
    title: 'Configurações do app',
    tabs: [{ id: 'voice', label: 'Voz e Áudio', icon: Mic }],
  },
];

const TAB_TITLE: Record<SettingsTab, string> = {
  account: 'Minha Conta',
  profile: 'Perfil',
  voice: 'Voz e Áudio',
};

export const SettingsModal: FC<SettingsModalProps> = ({
  user,
  initialTab,
  serverVersion,
  onClose,
  onLogout,
  onUserUpdated,
}) => {
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

  const logout = () => {
    onClose();
    onLogout();
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') guardedClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  return (
    <div className="settings-screen" role="dialog" aria-modal="true" aria-label="Configurações de usuário">
      <nav className="settings-nav" role="tablist">
        <div className="settings-nav-inner">
          {GROUPS.map((group) => (
            <div className="settings-nav-group" key={group.title}>
              <h2 className="settings-nav-title">{group.title}</h2>
              {group.tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  className={`settings-nav-item ${tab === id ? 'active' : ''}`}
                  onClick={() => guardedTabChange(id)}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ))}

          <div className="settings-nav-divider" />
          <button className="settings-nav-item danger" onClick={logout}>
            <LogOut size={16} />
            <span>Sair</span>
          </button>

          <div className="settings-nav-version">
            DasCord v{APP_VERSION}
            <br />
            Servidor {serverVersion ? `v${serverVersion}` : 'desconhecido'}
          </div>
        </div>
      </nav>

      <div className="settings-content">
        <div className="settings-content-inner">
          <h1 className="settings-page-title">{TAB_TITLE[tab]}</h1>
          {tab === 'account' && <AccountTab user={user} />}
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

        {/* O botão de fechar acompanha a rolagem, como no Discord */}
        <div className="settings-close">
          <button className="settings-close-btn" onClick={guardedClose} aria-label="Fechar configurações">
            <X size={18} />
          </button>
          <span className="settings-close-hint">ESC</span>
        </div>
      </div>
    </div>
  );
};

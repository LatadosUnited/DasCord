import { FC, FormEvent, useState } from 'react';
import { Pencil, Smile, X } from 'lucide-react';
import { User, UserStatus } from '../types';
import { MAX_CUSTOM_STATUS_CHARS, STATUS_OPTIONS } from '../services/presence';

interface StatusMenuProps {
  user: User;
  onChange: (status: UserStatus, customStatus: string) => void;
  onEditProfile: () => void;
  onClose: () => void;
}

/** Menu que abre ao clicar no próprio avatar: status de presença e status personalizado */
export const StatusMenu: FC<StatusMenuProps> = ({ user, onChange, onEditProfile, onClose }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(user.customStatus ?? '');

  const saveCustomStatus = (e: FormEvent) => {
    e.preventDefault();
    onChange(user.status, draft.trim());
    setEditing(false);
  };

  return (
    <div className="popover-menu status-menu" role="menu">
      <div className="status-menu-header">
        <div className="avatar-wrapper status-menu-avatar">
          <img src={user.avatar} alt={user.name} className="avatar-img" />
          <div className={`status-dot ${user.status}`} />
        </div>
        <div className="status-menu-names">
          <span className="status-menu-name">{user.name}</span>
          <span className="status-menu-tag">{user.tag}</span>
        </div>
      </div>

      <div className="popover-section">
        {editing ? (
          <form className="custom-status-form" onSubmit={saveCustomStatus}>
            <input
              className="settings-input"
              value={draft}
              maxLength={MAX_CUSTOM_STATUS_CHARS}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="O que você está fazendo?"
              autoFocus
            />
            <div className="custom-status-actions">
              <button type="button" className="settings-btn secondary" onClick={() => setEditing(false)}>
                Cancelar
              </button>
              <button type="submit" className="settings-btn">
                Salvar
              </button>
            </div>
          </form>
        ) : user.customStatus ? (
          <div className="custom-status-current">
            <span className="custom-status-text">{user.customStatus}</span>
            <button
              className="icon-btn"
              title="Editar status personalizado"
              onClick={() => {
                setDraft(user.customStatus ?? '');
                setEditing(true);
              }}
            >
              <Pencil size={14} />
            </button>
            <button className="icon-btn" title="Limpar status personalizado" onClick={() => onChange(user.status, '')}>
              <X size={14} />
            </button>
          </div>
        ) : (
          <button className="popover-item" onClick={() => setEditing(true)}>
            <Smile size={16} />
            <span>Definir status personalizado</span>
          </button>
        )}
      </div>

      <div className="popover-divider" />

      <div className="popover-section">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.id}
            className={`popover-item status-option ${user.status === option.id ? 'selected' : ''}`}
            onClick={() => {
              onChange(option.id, user.customStatus ?? '');
              onClose();
            }}
          >
            <span className={`status-swatch ${option.id}`} />
            <span className="status-option-text">
              <span>{option.label}</span>
              {option.description && <small>{option.description}</small>}
            </span>
          </button>
        ))}
      </div>

      <div className="popover-divider" />

      <div className="popover-section">
        <button
          className="popover-item"
          onClick={() => {
            onEditProfile();
            onClose();
          }}
        >
          <Pencil size={16} />
          <span>Editar perfil</span>
        </button>
      </div>
    </div>
  );
};

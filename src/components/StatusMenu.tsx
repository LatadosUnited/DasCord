import { FC, FormEvent, useState } from 'react';
import { ChevronLeft, ChevronRight, Pencil, Smile, X } from 'lucide-react';
import { User, UserStatus } from '../types';
import { MAX_CUSTOM_STATUS_CHARS, STATUS_OPTIONS, statusLabel } from '../services/presence';

interface StatusMenuProps {
  user: User;
  onChange: (status: UserStatus, customStatus: string) => void;
  onEditProfile: () => void;
  onClose: () => void;
}

/**
 * Menu que abre ao clicar no próprio avatar. Como no Discord, o primeiro nível é
 * o cartão de perfil com as ações; a lista de status fica um nível abaixo, para
 * caber na barra lateral sem virar uma parede de texto.
 */
export const StatusMenu: FC<StatusMenuProps> = ({ user, onChange, onEditProfile, onClose }) => {
  const [view, setView] = useState<'perfil' | 'status'>('perfil');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(user.customStatus ?? '');

  const saveCustomStatus = (e: FormEvent) => {
    e.preventDefault();
    onChange(user.status, draft.trim());
    setEditing(false);
  };

  const customStatusForm = (
    <form className="custom-status-form" onSubmit={saveCustomStatus}>
      <input
        className="input"
        value={draft}
        maxLength={MAX_CUSTOM_STATUS_CHARS}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="O que você está fazendo?"
        autoFocus
      />
      <div className="custom-status-actions">
        <button type="button" className="btn secondary" onClick={() => setEditing(false)}>
          Cancelar
        </button>
        <button type="submit" className="btn">
          Salvar
        </button>
      </div>
    </form>
  );

  if (view === 'status') {
    return (
      <div className="popover-menu status-menu" role="menu">
        <button className="popover-item status-back" onClick={() => setView('perfil')}>
          <ChevronLeft size={16} />
          <span>Status</span>
        </button>

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
          {editing ? (
            customStatusForm
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
      </div>
    );
  }

  return (
    <div className="popover-menu status-menu" role="menu">
      <div className="status-card">
        <div className="status-card-banner" />
        <div className="avatar-wrapper status-card-avatar">
          <img src={user.avatar} alt={user.name} className="avatar-img" />
          <div className={`status-dot ${user.status}`} />
        </div>
        <div className="status-card-names">
          <span className="status-menu-name">{user.name}</span>
          <span className="status-menu-tag">{user.tag}</span>
        </div>
        {user.customStatus && !editing && <p className="status-card-custom">{user.customStatus}</p>}
      </div>

      <div className="popover-section">
        {editing ? (
          customStatusForm
        ) : (
          <>
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

            <button className="popover-item status-row" onClick={() => setView('status')}>
              <span className={`status-swatch ${user.status}`} />
              <span className="status-row-label">{statusLabel(user.status)}</span>
              <ChevronRight size={16} className="status-row-chevron" />
            </button>

            <button
              className="popover-item"
              onClick={() => {
                setDraft(user.customStatus ?? '');
                setEditing(true);
              }}
            >
              <Smile size={16} />
              <span>{user.customStatus ? 'Editar status personalizado' : 'Definir status personalizado'}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
};

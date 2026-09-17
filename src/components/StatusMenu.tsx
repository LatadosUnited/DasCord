import { CSSProperties, FC, FormEvent, JSX, RefObject, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Pencil, Smile, X } from 'lucide-react';
import { User, UserStatus } from '../types';
import { MAX_CUSTOM_STATUS_CHARS, STATUS_OPTIONS, statusLabel } from '../services/presence';

interface StatusMenuProps {
  user: User;
  /** O painel do usuário, que o menu usa para se posicionar logo acima */
  anchorRef: RefObject<HTMLElement | null>;
  onChange: (status: UserStatus, customStatus: string) => void;
  onEditProfile: () => void;
  onClose: () => void;
}

/**
 * Menu que abre ao clicar no próprio avatar. Como no Discord, o primeiro nível é
 * o cartão de perfil com as ações; a lista de status fica um nível abaixo, para
 * caber na barra lateral sem virar uma parede de texto.
 */
export const StatusMenu: FC<StatusMenuProps> = ({ user, anchorRef, onChange, onEditProfile, onClose }) => {
  const [view, setView] = useState<'perfil' | 'status'>('perfil');
  const position = useAnchoredPosition(anchorRef);
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

  const wrap = (conteudo: JSX.Element) =>
    createPortal(
      <div className="popover-menu status-menu" role="menu" style={position}>
        {conteudo}
      </div>,
      document.body,
    );

  if (view === 'status') {
    return wrap(
      <>
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
      </>,
    );
  }

  return wrap(
    <>
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
    </>,
  );
};

/**
 * O menu vive fora da barra lateral, que corta o que passa dela, então ele é
 * posicionado à mão: encostado na esquerda da janela, por cima da lista de
 * servidores, e logo acima do painel do usuário.
 */
function useAnchoredPosition(anchorRef: RefObject<HTMLElement | null>): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setPosition({
        left: MARGEM,
        bottom: window.innerHeight - rect.top + 8,
        maxHeight: rect.top - MARGEM - 16,
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchorRef]);

  return position;
}

/** Distância da borda da janela, a mesma que a lista de servidores usa */
const MARGEM = 8;

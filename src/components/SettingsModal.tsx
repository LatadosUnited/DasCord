import { useState, FC } from 'react';
import { X, UserCheck } from 'lucide-react';
import { User, UserStatus } from '../types';

interface SettingsModalProps {
  user: User;
  onClose: () => void;
  onSave: (updatedUser: Partial<User>) => void;
  onLogout?: () => void;
}

export const SettingsModal: FC<SettingsModalProps> = ({
  user,
  onClose,
  onSave,
  onLogout,
}) => {
  const [name, setName] = useState(user.name);
  const [customStatus, setCustomStatus] = useState(user.customStatus || '');
  const [status, setStatus] = useState<UserStatus>(user.status);

  const handleSave = () => {
    onSave({
      name,
      customStatus,
      status,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <UserCheck size={20} color="#5865F2" />
            <span className="modal-title">Perfil do Usuário</span>
          </div>
          <button className="titlebar-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div className="avatar-wrapper" style={{ width: 64, height: 64 }}>
              <img src={user.avatar} alt={user.name} className="avatar-img" />
              <div
                className={`status-dot ${status}`}
                style={{ width: 16, height: 16, border: '3px solid #313338' }}
              />
            </div>
            <div>
              <h3 style={{ fontSize: '18px', fontWeight: 700, color: '#f2f3f5' }}>{user.name}</h3>
              <span style={{ fontSize: '12px', color: '#949ba4' }}>{user.tag}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '11px', fontWeight: 700, color: '#b5bac1', textTransform: 'uppercase' }}>
              Nome de Exibição
            </label>
            <input
              type="text"
              className="chat-input-field"
              style={{
                backgroundColor: '#1e1f22',
                padding: '10px 12px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '11px', fontWeight: 700, color: '#b5bac1', textTransform: 'uppercase' }}>
              Status Personalizado
            </label>
            <input
              type="text"
              className="chat-input-field"
              style={{
                backgroundColor: '#1e1f22',
                padding: '10px 12px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
              value={customStatus}
              onChange={(e) => setCustomStatus(e.target.value)}
              placeholder="Ex: Codando em Rust 🦀"
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '11px', fontWeight: 700, color: '#b5bac1', textTransform: 'uppercase' }}>
              Status de Presença
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
              {(
                [
                  { id: 'online', label: 'Disponível', color: '#23a55a' },
                  { id: 'idle', label: 'Ausente', color: '#f0b232' },
                  { id: 'dnd', label: 'Não Perturbe', color: '#f23f43' },
                  { id: 'offline', label: 'Invisível', color: '#80848e' },
                ] as const
              ).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStatus(s.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border:
                      status === s.id
                        ? '1px solid #5865F2'
                        : '1px solid rgba(255,255,255,0.08)',
                    backgroundColor:
                      status === s.id ? 'rgba(88, 101, 242, 0.15)' : '#2b2d31',
                    color: '#dbdee1',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: 600,
                  }}
                >
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      backgroundColor: s.color,
                    }}
                  />
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <div>
            {onLogout && (
              <button
                type="button"
                className="modal-btn"
                onClick={() => {
                  onClose();
                  onLogout();
                }}
                style={{ backgroundColor: 'rgba(242, 63, 67, 0.15)', color: '#f23f43' }}
              >
                Sair da Conta
              </button>
            )}
          </div>
          <div style={{ display: 'flex' }}>
            <button
              className="modal-btn"
              onClick={onClose}
              style={{ backgroundColor: '#4e5058', marginRight: '8px' }}
            >
              Cancelar
            </button>
            <button className="modal-btn" onClick={handleSave}>
              Salvar Alterações
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

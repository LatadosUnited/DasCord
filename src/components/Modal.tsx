import { FC, ReactNode, useEffect } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import './Modal.css';

interface ModalProps {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Impede fechar enquanto uma requisição está em andamento */
  busy?: boolean;
}

/** Diálogo centralizado: fecha com Esc, clique fora ou no X */
export const Modal: FC<ModalProps> = ({ title, subtitle, onClose, children, footer, busy = false }) => {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, busy]);

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <div className="modal-overlay" onMouseDown={close}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className="icon-btn dialog-close" onClick={close} title="Fechar (Esc)" disabled={busy}>
          <X size={20} />
        </button>
        <header className="dialog-header">
          <h2 className="dialog-title">{title}</h2>
          {subtitle && <p className="dialog-subtitle">{subtitle}</p>}
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>
  );
};

export const FormFeedback: FC<{ kind: 'error' | 'success'; children: ReactNode }> = ({ kind, children }) => (
  <div className={`form-feedback ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
    {kind === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
    <span>{children}</span>
  </div>
);

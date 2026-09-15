import { FC, ReactNode, useState } from 'react';
import { FormFeedback, Modal } from './Modal';

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  /** Executa a ação; devolve a mensagem de erro, ou null se deu certo */
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}

/** Confirmação de uma ação destrutiva, com estado de espera e erro */
export const ConfirmDialog: FC<ConfirmDialogProps> = ({ title, message, confirmLabel, onConfirm, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const failure = await onConfirm();
    if (failure) {
      setBusy(false);
      setError(failure);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <div className="dialog-footer-end">
          <button className="link-btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="btn danger" onClick={confirm} disabled={busy}>
            {busy ? 'Aguarde...' : confirmLabel}
          </button>
        </div>
      }
    >
      <p className="dialog-text">{message}</p>
      {error && <FormFeedback kind="error">{error}</FormFeedback>}
    </Modal>
  );
};

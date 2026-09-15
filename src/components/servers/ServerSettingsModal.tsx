import { ChangeEvent, FC, FormEvent, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { Server } from '../../types';
import { IMAGE_TYPES, imageFileError } from '../../services/api';
import {
  MAX_SERVER_NAME_CHARS,
  MIN_SERVER_NAME_CHARS,
  ServerDto,
  apiDeleteServer,
  apiRenameServer,
  apiUploadServerIcon,
} from '../../services/servers';
import { FormFeedback, Modal } from '../Modal';
import './servers.css';

interface ServerSettingsModalProps {
  server: Server;
  onClose: () => void;
  onServerUpdated: (server: ServerDto) => void;
  onDeleted: (serverId: string) => void;
}

/** Só para o dono: nome, ícone e exclusão do servidor */
export const ServerSettingsModal: FC<ServerSettingsModalProps> = ({ server, onClose, onServerUpdated, onDeleted }) => {
  const [name, setName] = useState(server.name);
  const [savingName, setSavingName] = useState(false);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = savingName || uploadingIcon || deleting;
  const trimmedName = name.trim();
  const canSaveName = trimmedName !== server.name && trimmedName.length >= MIN_SERVER_NAME_CHARS && !busy;

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSaveName) return;
    setSavingName(true);
    setError(null);
    setSuccess(null);
    const res = await apiRenameServer(server.id, trimmedName);
    setSavingName(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onServerUpdated(res.data.server);
    setName(res.data.server.name);
    setSuccess('Nome salvo.');
  };

  // O ícone é enviado assim que é escolhido
  const handleIconChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSuccess(null);
    const fileError = imageFileError(file);
    if (fileError) {
      setError(fileError);
      return;
    }
    setUploadingIcon(true);
    setError(null);
    const res = await apiUploadServerIcon(server.id, file);
    setUploadingIcon(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onServerUpdated(res.data.server);
    setSuccess('Ícone atualizado.');
  };

  const deleteServer = async () => {
    setDeleting(true);
    setError(null);
    const res = await apiDeleteServer(server.id);
    if (!res.ok) {
      setDeleting(false);
      setError(res.error);
      return;
    }
    onDeleted(server.id);
  };

  return (
    <Modal title="Configurações do servidor" subtitle={server.name} onClose={onClose} busy={busy}>
      <div className="server-settings-identity">
        <button
          type="button"
          className="icon-picker filled"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          title="Alterar ícone"
        >
          <span className="server-avatar" style={server.icon ? undefined : { background: server.gradient }}>
            {server.icon ? <img src={server.icon} alt={`Ícone de ${server.name}`} /> : server.initials}
          </span>
          <span className="icon-picker-overlay">
            <ImagePlus size={20} />
          </span>
        </button>
        <div className="icon-picker-actions">
          <button type="button" className="btn secondary" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            {uploadingIcon ? 'Enviando...' : 'Alterar ícone'}
          </button>
          <span className="form-help">PNG, JPG, GIF ou WebP, até 2 MB. Imagens quadradas ficam melhores.</span>
        </div>
        <input ref={fileInputRef} type="file" accept={IMAGE_TYPES.join(',')} onChange={handleIconChange} hidden />
      </div>

      <form className="form-row" onSubmit={saveName}>
        <label className="form-field">
          <span className="form-label">Nome do servidor</span>
          <input
            className="input"
            value={name}
            maxLength={MAX_SERVER_NAME_CHARS}
            onChange={(e) => {
              setName(e.target.value);
              setSuccess(null);
            }}
            disabled={busy}
          />
        </label>
        <button type="submit" className="btn" disabled={!canSaveName}>
          {savingName ? 'Salvando...' : 'Salvar'}
        </button>
      </form>

      {error && <FormFeedback kind="error">{error}</FormFeedback>}
      {success && <FormFeedback kind="success">{success}</FormFeedback>}

      {!server.isDefault && (
        <div className="danger-zone">
          <div className="danger-zone-text">
            <strong>Excluir servidor</strong>
            <span>Apaga o servidor, os canais, os convites e todas as mensagens. Não dá para desfazer.</span>
          </div>

          {confirmingDelete ? (
            <>
              <label className="form-field">
                <span className="form-label">Digite “{server.name}” para confirmar</span>
                <input
                  className="input"
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  disabled={deleting}
                  autoFocus
                />
              </label>
              <div className="danger-zone-actions">
                <button
                  className="link-btn"
                  onClick={() => {
                    setConfirmingDelete(false);
                    setConfirmName('');
                  }}
                  disabled={deleting}
                >
                  Cancelar
                </button>
                <button className="btn danger" onClick={deleteServer} disabled={confirmName.trim() !== server.name || deleting}>
                  {deleting ? 'Excluindo...' : 'Excluir para sempre'}
                </button>
              </div>
            </>
          ) : (
            <button className="btn danger fit" onClick={() => setConfirmingDelete(true)} disabled={busy}>
              Excluir servidor
            </button>
          )}
        </div>
      )}
    </Modal>
  );
};

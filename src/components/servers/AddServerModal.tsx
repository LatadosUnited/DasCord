import { ChangeEvent, FC, FormEvent, useEffect, useRef, useState } from 'react';
import { ChevronRight, ImagePlus, Link2, Sparkles } from 'lucide-react';
import { User } from '../../types';
import { IMAGE_TYPES, imageFileError } from '../../services/api';
import { isGuestUser } from '../../services/users';
import {
  MAX_SERVER_NAME_CHARS,
  MIN_SERVER_NAME_CHARS,
  ServerDto,
  apiAcceptInvite,
  apiCreateServer,
  apiUploadServerIcon,
  parseInviteCode,
} from '../../services/servers';
import { FormFeedback, Modal } from '../Modal';
import './servers.css';

type Step = 'choose' | 'create' | 'join';

interface AddServerModalProps {
  currentUser: User;
  onClose: () => void;
  /** Servidor recém-criado ou em que o usuário acabou de entrar */
  onServerReady: (server: ServerDto) => void;
}

/** Botão "+" da lista de servidores: criar um servidor ou entrar com convite */
export const AddServerModal: FC<AddServerModalProps> = ({ currentUser, onClose, onServerReady }) => {
  const guest = isGuestUser(currentUser);
  const [step, setStep] = useState<Step>('choose');
  const [name, setName] = useState(`Servidor de ${currentUser.name}`.slice(0, MAX_SERVER_NAME_CHARS));
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [inviteInput, setInviteInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Libera a URL temporária da prévia
  useEffect(() => {
    if (!iconFile) {
      setIconPreview(null);
      return;
    }
    const url = URL.createObjectURL(iconFile);
    setIconPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [iconFile]);

  const goTo = (next: Step) => {
    setError(null);
    setStep(next);
  };

  const handleIconChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite escolher o mesmo arquivo de novo
    if (!file) return;
    const fileError = imageFileError(file);
    setError(fileError);
    if (!fileError) setIconFile(file);
  };

  const createServer = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < MIN_SERVER_NAME_CHARS) {
      setError(`O nome precisa ter pelo menos ${MIN_SERVER_NAME_CHARS} caracteres.`);
      return;
    }
    setBusy(true);
    setError(null);

    const res = await apiCreateServer(trimmed);
    if (!res.ok) {
      setBusy(false);
      setError(res.error);
      return;
    }

    let server = res.data.server;
    if (iconFile) {
      // O servidor já existe: se o ícone falhar, dá para enviar de novo nas configurações
      const iconRes = await apiUploadServerIcon(server.id, iconFile);
      if (iconRes.ok) {
        server = iconRes.data.server;
      } else {
        console.warn('Servidor criado, mas o ícone não foi enviado:', iconRes.error);
      }
    }
    setBusy(false);
    onServerReady(server);
  };

  const joinServer = async (e: FormEvent) => {
    e.preventDefault();
    if (!parseInviteCode(inviteInput)) {
      setError('Cole o código ou o link do convite.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await apiAcceptInvite(inviteInput);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onServerReady(res.data.server);
  };

  if (step === 'create') {
    return (
      <Modal
        title="Personalize seu servidor"
        subtitle="Dê um nome e um ícone. Os dois podem ser trocados depois."
        onClose={onClose}
        busy={busy}
        footer={
          <>
            <button type="button" className="link-btn" onClick={() => goTo('choose')} disabled={busy}>
              Voltar
            </button>
            <button type="submit" form="create-server-form" className="btn" disabled={busy}>
              {busy ? 'Criando...' : 'Criar servidor'}
            </button>
          </>
        }
      >
        <form id="create-server-form" className="dialog-form" onSubmit={createServer}>
          <button
            type="button"
            className={`icon-picker ${iconPreview ? 'filled' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            title="Escolher ícone"
          >
            {iconPreview ? (
              <>
                <img src={iconPreview} alt="Prévia do ícone" />
                <span className="icon-picker-overlay">
                  <ImagePlus size={20} />
                </span>
              </>
            ) : (
              <span className="icon-picker-empty">
                <ImagePlus size={24} />
                <span>Ícone</span>
              </span>
            )}
          </button>
          <input ref={fileInputRef} type="file" accept={IMAGE_TYPES.join(',')} onChange={handleIconChange} hidden />

          <label className="form-field">
            <span className="form-label">Nome do servidor</span>
            <input
              className="input"
              value={name}
              maxLength={MAX_SERVER_NAME_CHARS}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              autoFocus
            />
            <span className="form-help">Você será o dono: só você pode renomear, trocar o ícone ou excluir.</span>
          </label>

          {error && <FormFeedback kind="error">{error}</FormFeedback>}
        </form>
      </Modal>
    );
  }

  if (step === 'join') {
    return (
      <Modal
        title="Entrar em um servidor"
        subtitle="Cole o convite que alguém compartilhou com você."
        onClose={onClose}
        busy={busy}
        footer={
          <>
            <button type="button" className="link-btn" onClick={() => goTo('choose')} disabled={busy}>
              Voltar
            </button>
            <button type="submit" form="join-server-form" className="btn" disabled={busy || !inviteInput.trim()}>
              {busy ? 'Entrando...' : 'Entrar no servidor'}
            </button>
          </>
        }
      >
        <form id="join-server-form" className="dialog-form" onSubmit={joinServer}>
          <label className="form-field">
            <span className="form-label">Código ou link do convite</span>
            <input
              className="input invite-code"
              value={inviteInput}
              onChange={(e) => {
                setInviteInput(e.target.value);
                setError(null);
              }}
              placeholder="hTKzmak2"
              disabled={busy}
              autoFocus
            />
            <span className="form-help">Os códigos têm 8 letras e números, como hTKzmak2.</span>
          </label>
          {error && <FormFeedback kind="error">{error}</FormFeedback>}
        </form>
      </Modal>
    );
  }

  return (
    <Modal
      title="Adicionar um servidor"
      subtitle="Um servidor é onde você e seus amigos acendem ideias juntos."
      onClose={onClose}
    >
      <button className="choice-card" onClick={() => goTo('create')} disabled={guest}>
        <span className="choice-icon">
          <Sparkles size={22} />
        </span>
        <span className="choice-text">
          <strong>Criar meu servidor</strong>
          <small>
            {guest
              ? 'Convidados não podem criar servidores. Crie uma conta para ter o seu.'
              : 'Começa com um canal de texto e um canal de voz.'}
          </small>
        </span>
        <ChevronRight size={18} className="choice-chevron" />
      </button>

      <button className="choice-card" onClick={() => goTo('join')}>
        <span className="choice-icon">
          <Link2 size={22} />
        </span>
        <span className="choice-text">
          <strong>Entrar com um convite</strong>
          <small>Use o código ou o link que alguém compartilhou com você.</small>
        </span>
        <ChevronRight size={18} className="choice-chevron" />
      </button>
    </Modal>
  );
};

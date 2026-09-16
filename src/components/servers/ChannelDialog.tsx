import { FC, FormEvent, useState } from 'react';
import { Hash, Volume2 } from 'lucide-react';
import { Channel, ChannelType } from '../../types';
import {
  MAX_CHANNEL_NAME_CHARS,
  MAX_CHANNEL_TOPIC_CHARS,
  ServerDto,
  apiCreateChannel,
  apiDeleteChannel,
  apiUpdateChannel,
  channelSlug,
} from '../../services/servers';
import { FormFeedback, Modal } from '../Modal';
import './servers.css';

export type ChannelDialogMode = 'create' | 'edit' | 'delete';

interface ChannelDialogProps {
  mode: ChannelDialogMode;
  serverId: string;
  /** Obrigatório em 'edit' e 'delete' */
  channel?: Channel;
  /** Em 'create': categoria do "+" que foi clicado */
  defaultCategory?: string;
  /** Categorias que já existem no servidor, para reaproveitar em vez de digitar de novo */
  categories: string[];
  onDone: (server: ServerDto) => void;
  onClose: () => void;
}

export const ChannelDialog: FC<ChannelDialogProps> = ({
  mode,
  serverId,
  channel,
  defaultCategory = '',
  categories,
  onDone,
  onClose,
}) => {
  const [name, setName] = useState(channel?.name ?? '');
  const [type, setType] = useState<ChannelType>(channel?.type ?? 'text');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [category, setCategory] = useState(channel?.category ?? defaultCategory);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // O servidor faz o mesmo com o nome: mostrar antes evita a surpresa de "Avisos" virar "avisos"
  const preview = type === 'text' ? channelSlug(name) : name.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!preview) {
      setError('Dê um nome ao canal.');
      return;
    }
    setBusy(true);
    setError(null);

    const res =
      mode === 'create'
        ? await apiCreateChannel(serverId, name, type, category)
        : await apiUpdateChannel(serverId, channel!.id, { name, topic, category });

    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onDone(res.data.server);
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const res = await apiDeleteChannel(serverId, channel!.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onDone(res.data.server);
  };

  if (mode === 'delete') {
    return (
      <Modal
        title={`Excluir #${channel?.name}`}
        subtitle="Isto não tem volta."
        onClose={onClose}
        busy={busy}
        footer={
          <>
            <button type="button" className="link-btn" onClick={onClose} disabled={busy}>
              Cancelar
            </button>
            <button type="button" className="btn danger" onClick={remove} disabled={busy}>
              {busy ? 'Excluindo...' : 'Excluir canal'}
            </button>
          </>
        }
      >
        <p className="dialog-text">
          {channel?.type === 'voice'
            ? 'Quem estiver na chamada deste canal vai ser desconectado.'
            : 'Todas as mensagens e imagens deste canal serão apagadas junto.'}
        </p>
        {error && <FormFeedback kind="error">{error}</FormFeedback>}
      </Modal>
    );
  }

  const criando = mode === 'create';

  return (
    <Modal
      title={criando ? 'Criar canal' : `Editar #${channel?.name}`}
      subtitle={criando ? 'Canais organizam as conversas por assunto.' : undefined}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="link-btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" form="channel-form" className="btn" disabled={busy || !preview}>
            {busy ? 'Salvando...' : criando ? 'Criar canal' : 'Salvar'}
          </button>
        </>
      }
    >
      <form id="channel-form" className="dialog-form" onSubmit={submit}>
        {criando && (
          <div className="form-field">
            <span className="form-label">Tipo de canal</span>
            <div className="channel-type-picker">
              <button
                type="button"
                className={`choice-card compact ${type === 'text' ? 'selected' : ''}`}
                onClick={() => setType('text')}
                disabled={busy}
              >
                <span className="choice-icon">
                  <Hash size={20} />
                </span>
                <span className="choice-text">
                  <strong>Texto</strong>
                  <small>Mensagens, imagens e reações</small>
                </span>
              </button>
              <button
                type="button"
                className={`choice-card compact ${type === 'voice' ? 'selected' : ''}`}
                onClick={() => setType('voice')}
                disabled={busy}
              >
                <span className="choice-icon">
                  <Volume2 size={20} />
                </span>
                <span className="choice-text">
                  <strong>Voz</strong>
                  <small>Conversa por áudio e tela</small>
                </span>
              </button>
            </div>
          </div>
        )}

        <label className="form-field">
          <span className="form-label">Nome do canal</span>
          <input
            className="input"
            value={name}
            maxLength={MAX_CHANNEL_NAME_CHARS}
            onChange={(e) => setName(e.target.value)}
            placeholder={type === 'text' ? 'avisos' : 'Sala de reunião'}
            disabled={busy}
            autoFocus
          />
          <span className="form-help">
            {type === 'text'
              ? preview
                ? `Vai aparecer como #${preview}`
                : 'Canais de texto ficam em minúsculas e sem espaços.'
              : 'Canais de voz ficam com o nome do jeito que você escrever.'}
          </span>
        </label>

        <label className="form-field">
          <span className="form-label">Categoria</span>
          <input
            className="input"
            value={category}
            maxLength={60}
            list="channel-categories"
            onChange={(e) => setCategory(e.target.value)}
            placeholder={type === 'voice' ? 'Canais de voz' : 'Canais de texto'}
            disabled={busy}
          />
          <datalist id="channel-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <span className="form-help">Canais com a mesma categoria aparecem juntos na lista.</span>
        </label>

        {!criando && (
          <label className="form-field">
            <span className="form-label">Assunto</span>
            <input
              className="input"
              value={topic}
              maxLength={MAX_CHANNEL_TOPIC_CHARS}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Para que serve este canal"
              disabled={busy}
            />
          </label>
        )}

        {error && <FormFeedback kind="error">{error}</FormFeedback>}
      </form>
    </Modal>
  );
};

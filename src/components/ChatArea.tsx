import { useState, useRef, useEffect, FC } from 'react';
import { createPortal } from 'react-dom';
import {
  Hash,
  AtSign,
  Phone,
  Video,
  Bell,
  Pin,
  Users,
  Search,
  PlusCircle,
  Smile,
  SmilePlus,
  Send,
  Reply,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { Channel, Message, User } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { EmojiPicker } from './EmojiPicker';
import {
  ATTACHMENT_TYPES,
  apiUploadAttachment,
  attachmentFileError,
} from '../services/attachments';
import './ChatArea.css';

/** Tamanho do painel de emoji; serve para decidir se ele cabe abaixo do botão */
const PAINEL_EMOJI = { largura: 356, altura: 426 };

/** Imagem escolhida na caixa de mensagem, antes de virar mensagem */
interface PendingAttachment {
  localId: string;
  name: string;
  /** URL local só para a miniatura; é revogada ao sair da tira */
  previewUrl: string;
  /** ID no servidor; só existe depois que o upload termina */
  id?: string;
  failed?: boolean;
}

interface ChatAreaProps {
  channel: Channel | undefined;
  messages: Message[];
  currentUser?: User;
  dmUser?: User;
  onSendMessage: (text: string, replyToId?: string, attachmentIds?: string[]) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onEditMessage: (messageId: string, content: string) => void;
  onDeleteMessage: (messageId: string) => void;
  /** Chamado a cada digitação; quem envia decide a frequência real no socket */
  onTyping: () => void;
  /** Nomes de quem está digitando agora neste canal */
  typingNames: string[];
  /** Dono do servidor: pode apagar mensagem de qualquer um */
  canModerate?: boolean;
  showMemberList: boolean;
  onToggleMemberList: () => void;
}

export const ChatArea: FC<ChatAreaProps> = ({
  channel,
  messages,
  currentUser,
  dmUser,
  onSendMessage,
  onToggleReaction,
  onEditMessage,
  onDeleteMessage,
  onTyping,
  typingNames,
  canModerate,
  showMemberList,
  onToggleMemberList,
}) => {
  const [inputText, setInputText] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [emojiNoCampo, setEmojiNoCampo] = useState(false);
  /** Onde desenhar a barra de reação; ela vive fora da rolagem, num portal */
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Trocar de canal descarta resposta, edição e imagens pendentes daquele canal
  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
    setPickerFor(null);
    setEmojiNoCampo(false);
    setDeletingId(null);
    setAttachmentError(null);
    setAttachments((prev) => {
      prev.forEach((a) => URL.revokeObjectURL(a.previewUrl));
      return [];
    });
  }, [channel?.id]);

  const uploadedIds = attachments.filter((a) => a.id).map((a) => a.id!);
  const uploading = attachments.some((a) => !a.id && !a.failed);
  const canSend = (inputText.trim().length > 0 || uploadedIds.length > 0) && !uploading;

  /**
   * A barra de reação é grande e ficaria cortada pela rolagem das mensagens, então vai
   * num portal com posição fixa: abaixo do botão, ou acima dele quando não couber.
   */
  const abrirReacao = (messageId: string, botao: HTMLElement) => {
    if (pickerFor === messageId) {
      setPickerFor(null);
      return;
    }
    const r = botao.getBoundingClientRect();
    const abaixo = r.bottom + 8;
    const top =
      abaixo + PAINEL_EMOJI.altura > window.innerHeight - 8
        ? Math.max(8, r.top - 8 - PAINEL_EMOJI.altura)
        : abaixo;
    const left = Math.min(
      Math.max(8, r.right - PAINEL_EMOJI.largura),
      window.innerWidth - PAINEL_EMOJI.largura - 8,
    );
    setEmojiNoCampo(false);
    setPickerPos({ top, left });
    setPickerFor(messageId);
  };

  /**
   * Emoji entra onde o cursor parou, não no fim do texto. O foco fica no seletor,
   * que continua aberto para emendar outro emoji; só a posição do cursor é acertada.
   */
  const inserirEmoji = (emoji: string) => {
    const campo = inputRef.current;
    const inicio = campo?.selectionStart ?? inputText.length;
    const fim = campo?.selectionEnd ?? inicio;
    setInputText(inputText.slice(0, inicio) + emoji + inputText.slice(fim));
    const cursor = inicio + emoji.length;
    requestAnimationFrame(() => campo?.setSelectionRange(cursor, cursor));
  };

  /** Tira a imagem da tira e devolve a memória da miniatura */
  const dropAttachments = (keep: (a: PendingAttachment) => boolean) => {
    setAttachments((prev) => {
      prev.filter((a) => !keep(a)).forEach((a) => URL.revokeObjectURL(a.previewUrl));
      return prev.filter(keep);
    });
  };

  const handlePickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = ''; // permite escolher o mesmo arquivo de novo
    if (files.length === 0 || !channel) return;
    setAttachmentError(null);

    for (const file of files) {
      const problem = attachmentFileError(file);
      if (problem) {
        setAttachmentError(problem);
        continue;
      }
      const pending: PendingAttachment = {
        localId: `${Date.now()}-${file.name}`,
        name: file.name,
        previewUrl: URL.createObjectURL(file),
      };
      setAttachments((prev) => [...prev, pending]);

      const res = await apiUploadAttachment(channel.id, file);
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === pending.localId
            ? { ...a, id: res.ok ? res.data.attachment.id : undefined, failed: !res.ok }
            : a
        )
      );
      if (!res.ok) setAttachmentError(`${file.name}: ${res.error}`);
    }
  };

  const handleSend = () => {
    if (!canSend) return;
    onSendMessage(inputText.trim(), replyTo?.id, uploadedIds.length > 0 ? uploadedIds : undefined);
    setInputText('');
    setReplyTo(null);
    setAttachmentError(null);
    dropAttachments(() => false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape' && replyTo) {
      setReplyTo(null);
    }
  };

  const startReply = (msg: Message) => {
    setReplyTo({ id: msg.id, authorName: msg.author.name });
    setEditing(null);
    inputRef.current?.focus();
  };

  const saveEdit = () => {
    if (!editing) return;
    const text = editing.text.trim();
    const original = messages.find((m) => m.id === editing.id);
    if (text && text !== original?.content) {
      onEditMessage(editing.id, text);
    }
    setEditing(null);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      setEditing(null);
    }
  };

  const channelName = channel ? channel.name : 'geral';
  const deletingMessage = messages.find((m) => m.id === deletingId);
  const typingLabel =
    typingNames.length === 1
      ? `${typingNames[0]} está digitando...`
      : typingNames.length > 1 && typingNames.length < 4
        ? `${typingNames.slice(0, -1).join(', ')} e ${typingNames[typingNames.length - 1]} estão digitando...`
        : typingNames.length >= 4
          ? 'Várias pessoas estão digitando...'
          : '';

  return (
    <div className="chat-area">
      <div className="chat-header">
        <div className="chat-header-left">
          {dmUser ? (
            <AtSign size={22} className="chat-header-icon" />
          ) : (
            <Hash size={24} className="chat-header-icon" />
          )}
          <span className="chat-channel-title">{dmUser ? dmUser.name : channelName}</span>
          {dmUser && <span className="chat-dm-tag">{dmUser.tag}</span>}
          {channel?.topic && !dmUser && (
            <>
              <div className="chat-divider" />
              <span className="chat-topic">{channel.topic}</span>
            </>
          )}
        </div>

        <div className="chat-header-right">
          {dmUser ? (
            <>
              <button className="header-icon-btn" title="Iniciar chamada de voz">
                <Phone size={20} />
              </button>
              <button className="header-icon-btn" title="Iniciar chamada de vídeo">
                <Video size={20} />
              </button>
            </>
          ) : (
            <button className="header-icon-btn" title="Notificações">
              <Bell size={20} />
            </button>
          )}

          <button className="header-icon-btn" title="Mensagens fixadas">
            <Pin size={20} />
          </button>

          {!dmUser && (
            <button
              className={`header-icon-btn ${showMemberList ? 'active' : ''}`}
              onClick={onToggleMemberList}
              title="Alternar lista de membros"
            >
              <Users size={20} />
            </button>
          )}

          <div className="search-box">
            <input type="text" placeholder="Buscar" className="search-input" />
            <Search size={14} />
          </div>
        </div>
      </div>

      <div className="chat-messages" onScroll={() => pickerFor && setPickerFor(null)}>
        {dmUser ? (
          <div className="channel-welcome-banner dm-welcome-banner">
            <div className="dm-welcome-avatar-wrapper">
              <img src={dmUser.avatar} alt={dmUser.name} className="dm-welcome-avatar" />
              <div className={`status-dot ${dmUser.status} dm-welcome-status`} />
            </div>
            <h1 className="welcome-title">{dmUser.name}</h1>
            <div className="dm-welcome-tag">
              {dmUser.name}
              <span className="dm-welcome-handle">{dmUser.tag}</span>
            </div>
            <p className="welcome-subtitle">
              Este é o início do histórico de mensagens diretas com <strong>{dmUser.name}</strong>.
            </p>
          </div>
        ) : (
          <div className="channel-welcome-banner">
            <div className="welcome-hash-circle">
              <Hash size={36} />
            </div>
            <h1 className="welcome-title">Bem-vindo a #{channelName}!</h1>
            <p className="welcome-subtitle">
              Este é o início do canal #{channelName}. Toda grande ideia começa com uma conversa.
            </p>
          </div>
        )}

        {messages.map((msg) => {
          const isOwn = currentUser?.id === msg.author.id;
          // Mensagem ainda sem confirmação do servidor não aceita edição nem reação
          const isSaved = msg.createdAt !== undefined && msg.timestamp !== 'Enviando...';

          return (
            <div key={msg.id} className="message-item">
              <img src={msg.author.avatar} alt={msg.author.name} className="message-avatar" />
              <div className="message-content-wrapper">
                {msg.replyTo && (
                  <div className="message-reply-context">
                    <Reply size={13} />
                    <span className="message-reply-author">{msg.replyTo.authorName || 'Alguém'}</span>
                    <span className={`message-reply-text ${msg.replyTo.deleted ? 'deleted' : ''}`}>
                      {msg.replyTo.deleted ? 'mensagem apagada' : msg.replyTo.content}
                    </span>
                  </div>
                )}

                <div className="message-header">
                  {/* A cor do cargo é um dado do usuário */}
                  <span className="message-author" style={{ color: msg.author.roleColor }}>
                    {msg.author.name}
                  </span>
                  {msg.author.isBot && <span className="bot-tag">BOT</span>}
                  <span className="message-timestamp">{msg.timestamp}</span>
                </div>

                {editing?.id === msg.id ? (
                  <>
                    <input
                      type="text"
                      className="message-edit-field"
                      value={editing.text}
                      autoFocus
                      onChange={(e) => setEditing({ id: msg.id, text: e.target.value })}
                      onKeyDown={handleEditKeyDown}
                    />
                    <div className="message-edit-hint">
                      <strong>Esc</strong> cancela · <strong>Enter</strong> salva
                    </div>
                  </>
                ) : (
                  <div className="message-text">
                    {/* Parse simples de negrito */}
                    {msg.content.split('**').map((chunk, i) => (i % 2 === 1 ? <strong key={i}>{chunk}</strong> : chunk))}
                    {msg.editedAt && <span className="message-edited-tag">(editada)</span>}
                  </div>
                )}

                {msg.attachments?.map((att, idx) =>
                  att.type === 'image' && att.url ? (
                    <a
                      key={att.id ?? idx}
                      href={att.url}
                      target="_blank"
                      rel="noreferrer"
                      className="message-image-link"
                      title={att.name}
                    >
                      <img src={att.url} alt={att.name || 'Imagem'} className="message-image" loading="lazy" />
                    </a>
                  ) : att.type === 'code' && att.code ? (
                    <div key={idx} className="message-code-block">
                      <div className="code-block-header">
                        <span>{att.title || 'Rust Code'}</span>
                        <span>{att.language || 'rust'}</span>
                      </div>
                      <pre className="code-content">
                        <code>{att.code}</code>
                      </pre>
                    </div>
                  ) : null
                )}

                {msg.reactions && msg.reactions.length > 0 && (
                  <div className="reactions-row">
                    {msg.reactions.map((reaction) => (
                      <button
                        key={reaction.emoji}
                        className={`reaction-chip ${
                          currentUser && reaction.userIds.includes(currentUser.id) ? 'active' : ''
                        }`}
                        onClick={() => onToggleReaction(msg.id, reaction.emoji)}
                      >
                        <span>{reaction.emoji}</span>
                        <span>{reaction.userIds.length}</span>
                      </button>
                    ))}
                    {/* Reagir de novo sem subir até a barra que aparece no topo da mensagem */}
                    {isSaved && (
                      <button
                        className="reaction-add"
                        title="Adicionar reação"
                        data-emoji-toggle
                        onClick={(e) => abrirReacao(msg.id, e.currentTarget)}
                      >
                        <SmilePlus size={15} />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {isSaved && !editing && (
                <div className="message-actions">
                  <button
                    className="message-action-btn"
                    title="Reagir"
                    // O seletor ignora o clique daqui para não fechar e reabrir na mesma ação
                    data-emoji-toggle
                    onClick={(e) => abrirReacao(msg.id, e.currentTarget)}
                  >
                    <Smile size={16} />
                  </button>
                  <button className="message-action-btn" title="Responder" onClick={() => startReply(msg)}>
                    <Reply size={16} />
                  </button>
                  {isOwn && (
                    <button
                      className="message-action-btn"
                      title="Editar"
                      onClick={() => setEditing({ id: msg.id, text: msg.content })}
                    >
                      <Pencil size={16} />
                    </button>
                  )}
                  {(isOwn || canModerate) && (
                    <button
                      className="message-action-btn danger"
                      title="Apagar"
                      onClick={() => setDeletingId(msg.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              )}

            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-container">
        {replyTo && (
          <div className="reply-bar">
            <span>
              Respondendo a <span className="reply-bar-target">{replyTo.authorName}</span>
            </span>
            <button className="reply-bar-close" onClick={() => setReplyTo(null)} title="Cancelar resposta">
              <X size={16} />
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachment-tray">
            {attachments.map((att) => (
              <div
                key={att.localId}
                className={`attachment-preview ${att.id ? '' : 'uploading'}`}
                title={att.name}
              >
                <img src={att.previewUrl} alt={att.name} />
                {!att.id && (
                  <span className="attachment-preview-status">
                    {att.failed ? 'falhou' : 'enviando...'}
                  </span>
                )}
                <button
                  className="attachment-preview-remove"
                  title="Tirar esta imagem"
                  onClick={() => dropAttachments((a) => a.localId !== att.localId)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachmentError && <div className="attachment-error">{attachmentError}</div>}
        {emojiNoCampo && (
          <div className="composer-picker-anchor">
            <EmojiPicker onPick={inserirEmoji} onClose={() => setEmojiNoCampo(false)} />
          </div>
        )}
        <div className="chat-input-bar">
          <button
            className="chat-input-btn"
            title="Enviar imagem"
            onClick={() => fileInputRef.current?.click()}
          >
            <PlusCircle size={22} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACHMENT_TYPES.join(',')}
            multiple
            onChange={handlePickFiles}
            hidden
          />

          <input
            ref={inputRef}
            type="text"
            className="chat-input-field"
            placeholder={
              replyTo
                ? `Responder a ${replyTo.authorName}`
                : dmUser
                  ? `Conversar com @${dmUser.name}`
                  : `Conversar em #${channelName}`
            }
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              if (e.target.value.trim()) onTyping();
            }}
            onKeyDown={handleKeyDown}
          />

          <button
            className={`chat-input-btn ${emojiNoCampo ? 'ativo' : ''}`}
            title="Adicionar emoji"
            // O seletor ignora o clique daqui para não fechar e reabrir na mesma ação
            data-emoji-toggle
            onClick={() => {
              setPickerFor(null);
              setEmojiNoCampo((v) => !v);
            }}
          >
            <Smile size={22} />
          </button>
          {canSend && (
            <button className="chat-input-btn chat-send-btn" onClick={handleSend} title="Enviar mensagem">
              <Send size={20} />
            </button>
          )}
        </div>
        <div className="typing-indicator">{typingLabel}</div>
      </div>

      {deletingMessage && (
        <ConfirmDialog
          title="Apagar mensagem?"
          message={`"${deletingMessage.content.slice(0, 120)}" será apagada para todos. Isso não pode ser desfeito.`}
          confirmLabel="Apagar"
          onConfirm={async () => {
            onDeleteMessage(deletingMessage.id);
            setDeletingId(null);
            return null;
          }}
          onClose={() => setDeletingId(null)}
        />
      )}

      {pickerFor &&
        pickerPos &&
        createPortal(
          <div className="reaction-picker-anchor" style={pickerPos}>
            <EmojiPicker
              fecharAoEscolher
              onPick={(emoji) => onToggleReaction(pickerFor, emoji)}
              onClose={() => setPickerFor(null)}
            />
          </div>,
          document.body,
        )}
    </div>
  );
};

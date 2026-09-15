import { useState, useRef, useEffect, FC } from 'react';
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
  Gift,
  Smile,
  Send,
} from 'lucide-react';
import { Channel, Message, User } from '../types';

interface ChatAreaProps {
  channel: Channel | undefined;
  messages: Message[];
  currentUser?: User;
  dmUser?: User;
  onSendMessage: (text: string) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  showMemberList: boolean;
  onToggleMemberList: () => void;
}

export const ChatArea: FC<ChatAreaProps> = ({
  channel,
  messages,
  dmUser,
  onSendMessage,
  onToggleReaction,
  showMemberList,
  onToggleMemberList,
}) => {
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inputText.trim()) {
        onSendMessage(inputText.trim());
        setInputText('');
      }
    }
  };

  const handleSend = () => {
    if (inputText.trim()) {
      onSendMessage(inputText.trim());
      setInputText('');
    }
  };

  return (
    <div className="chat-area">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          {dmUser ? (
            <AtSign size={22} color="#80848e" />
          ) : (
            <Hash size={24} color="#80848e" />
          )}
          <span className="chat-channel-title">
            {dmUser ? dmUser.name : channel ? channel.name : 'geral'}
          </span>
          {dmUser && (
            <span className="chat-dm-tag" style={{ color: '#949ba4', fontSize: '13px' }}>
              {dmUser.tag}
            </span>
          )}
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

          <button className="header-icon-btn" title="Mensagens Fixadas">
            <Pin size={20} />
          </button>

          {!dmUser && (
            <button
              className={`header-icon-btn ${showMemberList ? 'active' : ''}`}
              onClick={onToggleMemberList}
              title="Alternar Lista de Membros"
            >
              <Users size={20} />
            </button>
          )}

          <div className="search-box">
            <input type="text" placeholder="Buscar" className="search-input" />
            <Search size={14} color="#949ba4" />
          </div>
        </div>
      </div>

      {/* Messages Stream */}
      <div className="chat-messages">
        {/* Welcome Banner */}
        {dmUser ? (
          <div className="channel-welcome-banner dm-welcome-banner">
            <div className="dm-welcome-avatar-wrapper">
              <img
                src={dmUser.avatar}
                alt={dmUser.name}
                className="dm-welcome-avatar"
              />
              <div className={`status-dot ${dmUser.status} dm-welcome-status`} />
            </div>
            <h1 className="welcome-title">{dmUser.name}</h1>
            <div className="dm-welcome-tag">
              {dmUser.name}
              <span style={{ color: '#949ba4' }}>{dmUser.tag}</span>
            </div>
            <p className="welcome-subtitle">
              Este é o início do histórico de mensagens diretas com{' '}
              <strong>{dmUser.name}</strong>.
            </p>
          </div>
        ) : (
          <div className="channel-welcome-banner">
            <div className="welcome-hash-circle">
              <Hash size={40} />
            </div>
            <h1 className="welcome-title">Bem-vindo a #{channel ? channel.name : 'geral'}!</h1>
            <p className="welcome-subtitle">
              Este é o início do canal #{channel ? channel.name : 'geral'}. O chat está rodando com
              Rust IPC e Tauri v2.
            </p>
          </div>
        )}

        {/* Messages */}
        {messages.map((msg) => (
          <div key={msg.id} className="message-item">
            <img src={msg.author.avatar} alt={msg.author.name} className="message-avatar" />
            <div className="message-content-wrapper">
              <div className="message-header">
                <span className="message-author" style={{ color: msg.author.roleColor }}>
                  {msg.author.name}
                </span>
                {msg.author.isBot && <span className="bot-tag">BOT</span>}
                <span className="message-timestamp">{msg.timestamp}</span>
              </div>

              <div className="message-text">
                {/* Parse simples de negrito */}
                {msg.content.split('**').map((chunk, i) =>
                  i % 2 === 1 ? <strong key={i}>{chunk}</strong> : chunk
                )}
              </div>

              {/* Code Snippet Attachment */}
              {msg.attachments?.map((att, idx) => {
                if (att.type === 'code' && att.code) {
                  return (
                    <div key={idx} className="message-code-block">
                      <div className="code-block-header">
                        <span>{att.title || 'Rust Code'}</span>
                        <span>{att.language || 'rust'}</span>
                      </div>
                      <pre className="code-content">
                        <code>{att.code}</code>
                      </pre>
                    </div>
                  );
                }
                return null;
              })}

              {/* Reactions */}
              {msg.reactions && msg.reactions.length > 0 && (
                <div className="reactions-row">
                  {msg.reactions.map((reaction, rIdx) => (
                    <button
                      key={rIdx}
                      className={`reaction-chip ${reaction.active ? 'active' : ''}`}
                      onClick={() => onToggleReaction(msg.id, reaction.emoji)}
                    >
                      <span>{reaction.emoji}</span>
                      <span>{reaction.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Message Input Box */}
      <div className="chat-input-container">
        <div className="chat-input-bar">
          <button className="chat-input-btn" title="Enviar arquivo">
            <PlusCircle size={22} />
          </button>

          <input
            type="text"
            className="chat-input-field"
            placeholder={
              dmUser
                ? `Conversar com @${dmUser.name}`
                : `Conversar em #${channel ? channel.name : 'geral'}`
            }
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
          />

          <button className="chat-input-btn" title="Enviar Presente / Nitro">
            <Gift size={22} />
          </button>
          <button
            className="chat-input-btn"
            title="Adicionar Emoji"
            onClick={() => setInputText((prev) => prev + ' 🦀')}
          >
            <Smile size={22} />
          </button>
          {inputText.trim() && (
            <button
              className="chat-input-btn"
              onClick={handleSend}
              title="Enviar Mensagem"
              style={{ color: '#5865F2' }}
            >
              <Send size={20} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

import { useState, useRef, useEffect, FC } from 'react';
import { Hash, AtSign, Phone, Video, Bell, Pin, Users, Search, PlusCircle, Smile, Send } from 'lucide-react';
import { Channel, Message, User } from '../types';
import './ChatArea.css';

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

  const handleSend = () => {
    if (inputText.trim()) {
      onSendMessage(inputText.trim());
      setInputText('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const channelName = channel ? channel.name : 'geral';

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

      <div className="chat-messages">
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

        {messages.map((msg) => (
          <div key={msg.id} className="message-item">
            <img src={msg.author.avatar} alt={msg.author.name} className="message-avatar" />
            <div className="message-content-wrapper">
              <div className="message-header">
                {/* A cor do cargo é um dado do usuário */}
                <span className="message-author" style={{ color: msg.author.roleColor }}>
                  {msg.author.name}
                </span>
                {msg.author.isBot && <span className="bot-tag">BOT</span>}
                <span className="message-timestamp">{msg.timestamp}</span>
              </div>

              <div className="message-text">
                {/* Parse simples de negrito */}
                {msg.content.split('**').map((chunk, i) => (i % 2 === 1 ? <strong key={i}>{chunk}</strong> : chunk))}
              </div>

              {msg.attachments?.map((att, idx) =>
                att.type === 'code' && att.code ? (
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

      <div className="chat-input-container">
        <div className="chat-input-bar">
          <button className="chat-input-btn" title="Enviar arquivo">
            <PlusCircle size={22} />
          </button>

          <input
            type="text"
            className="chat-input-field"
            placeholder={dmUser ? `Conversar com @${dmUser.name}` : `Conversar em #${channelName}`}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
          />

          <button
            className="chat-input-btn"
            title="Adicionar emoji"
            onClick={() => setInputText((prev) => prev + ' 💡')}
          >
            <Smile size={22} />
          </button>
          {inputText.trim() && (
            <button className="chat-input-btn chat-send-btn" onClick={handleSend} title="Enviar mensagem">
              <Send size={20} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

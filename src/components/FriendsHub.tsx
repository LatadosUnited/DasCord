import { FC, useState } from 'react';
import {
  Users,
  UserPlus,
  Check,
  X,
  MessageSquare,
  Search,
  PhoneCall,
  Clock,
  Sparkles,
} from 'lucide-react';
import { User } from '../types';
import {
  FriendsSummary,
  apiSendFriendRequest,
  apiAcceptFriendRequest,
  apiDeclineFriendRequest,
} from '../services/friends';
import { getLocalSession } from '../services/auth';

interface FriendsHubProps {
  summary: FriendsSummary;
  currentUser: User;
  onRefresh: () => void;
  onOpenDM: (friend: User) => void;
}

type TabType = 'online' | 'all' | 'pending' | 'add';

export const FriendsHub: FC<FriendsHubProps> = ({
  summary,
  currentUser: _currentUser,
  onRefresh,
  onOpenDM,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('online');
  const [searchFilter, setSearchFilter] = useState('');
  const [addQuery, setAddQuery] = useState('');
  const [addStatus, setAddStatus] = useState<{
    type: 'success' | 'error' | null;
    message: string;
  }>({ type: null, message: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const pendingCount = summary.incoming_requests.length;

  const handleSendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addQuery.trim()) return;

    const { token } = getLocalSession();
    if (!token) {
      setAddStatus({
        type: 'error',
        message: 'Você precisa estar autenticado para enviar pedidos.',
      });
      return;
    }

    setIsSubmitting(true);
    setAddStatus({ type: null, message: '' });

    const res = await apiSendFriendRequest(token, addQuery.trim());
    setIsSubmitting(false);

    if (res.success) {
      setAddStatus({
        type: 'success',
        message: res.message || `Pedido enviado com sucesso para ${addQuery}!`,
      });
      setAddQuery('');
      onRefresh();
    } else {
      setAddStatus({
        type: 'error',
        message:
          res.error ||
          'Não foi possível enviar o pedido de amizade. Verifique a ortografia.',
      });
    }
  };

  const handleAccept = async (requestId: string) => {
    const { token } = getLocalSession();
    if (!token) return;
    const res = await apiAcceptFriendRequest(token, requestId);
    if (res.success) {
      onRefresh();
    }
  };

  const handleDecline = async (requestId: string) => {
    const { token } = getLocalSession();
    if (!token) return;
    const res = await apiDeclineFriendRequest(token, requestId);
    if (res.success) {
      onRefresh();
    }
  };

  // Filter friends list
  const filteredFriends = summary.friends.filter((f) => {
    const matchesSearch =
      f.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
      f.tag.includes(searchFilter);

    if (activeTab === 'online') {
      return matchesSearch && f.status !== 'offline';
    }
    return matchesSearch;
  });

  return (
    <div className="friends-hub-container">
      {/* Top Header Bar */}
      <header className="friends-header">
        <div className="friends-header-left">
          <div className="friends-header-title">
            <Users size={24} className="header-icon" />
            <span>Amigos</span>
          </div>

          <div className="header-divider" />

          {/* Navigation Tabs */}
          <nav className="friends-tabs">
            <button
              className={`tab-btn ${activeTab === 'online' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('online');
                setAddStatus({ type: null, message: '' });
              }}
            >
              Disponível
            </button>
            <button
              className={`tab-btn ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('all');
                setAddStatus({ type: null, message: '' });
              }}
            >
              Todos
            </button>
            <button
              className={`tab-btn ${activeTab === 'pending' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('pending');
                setAddStatus({ type: null, message: '' });
              }}
            >
              Pendentes
              {pendingCount > 0 && (
                <span className="pending-badge">{pendingCount}</span>
              )}
            </button>
            <button
              className={`tab-btn add-btn ${activeTab === 'add' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('add');
                setAddStatus({ type: null, message: '' });
              }}
            >
              Adicionar amigo
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content Body */}
      <div className="friends-main-body">
        <div className="friends-content-column">
          {/* TAB: ADICIONAR AMIGO */}
          {activeTab === 'add' && (
            <div className="add-friend-section">
              <h2 className="section-title">ADICIONAR AMIGO</h2>
              <p className="section-subtitle">
                Você pode adicionar amigos com o nome de usuário ou tag (ex:{' '}
                <strong>leandro#9500</strong>).
              </p>

              <form className="add-friend-form" onSubmit={handleSendRequest}>
                <div className="add-friend-input-wrapper">
                  <input
                    type="text"
                    value={addQuery}
                    onChange={(e) => setAddQuery(e.target.value)}
                    placeholder="Você pode adicionar amigos com o nome de usuário ou tag (ex: leandro#9500)"
                    className="add-friend-input"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={!addQuery.trim() || isSubmitting}
                    className="submit-request-btn"
                  >
                    {isSubmitting ? 'Enviando...' : 'Enviar pedido de amizade'}
                  </button>
                </div>
              </form>

              {addStatus.type && (
                <div className={`status-feedback-box ${addStatus.type}`}>
                  {addStatus.type === 'success' ? (
                    <Check size={18} />
                  ) : (
                    <X size={18} />
                  )}
                  <span>{addStatus.message}</span>
                </div>
              )}

              <div className="add-friend-tips">
                <div className="tips-card">
                  <Sparkles size={24} color="#5865F2" />
                  <div>
                    <h4>Como funciona a identificação no DasCord?</h4>
                    <p>
                      Cada usuário possui um identificador Snowflake único de 64 bits
                      e uma tag de 4 dígitos gerada nativamente em Rust.
                      Você pode buscar pelo nome de usuário com tag (ex: <code>leandro_rust#9500</code>)
                      ou apenas pelo nome de usuário. O nome de exibição e o e-mail não são aceitos.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB: PENDENTES */}
          {activeTab === 'pending' && (
            <div className="pending-requests-section">
              <h3 className="list-section-header">
                PEDIDOS RECEBIDOS — {summary.incoming_requests.length}
              </h3>

              {summary.incoming_requests.length === 0 ? (
                <div className="empty-state">
                  <Clock size={40} color="#4e5058" />
                  <p>Nenhum pedido de amizade recebido.</p>
                </div>
              ) : (
                <div className="requests-list">
                  {summary.incoming_requests.map((req) => (
                    <div key={req.request_id} className="request-card">
                      <div className="request-user-info">
                        <div className="avatar-wrapper">
                          <img
                            src={req.from_user.avatar}
                            alt={req.from_user.name}
                            className="user-avatar"
                          />
                          <span className={`status-indicator ${req.from_user.status}`} />
                        </div>
                        <div className="user-details">
                          <span className="user-name">
                            {req.from_user.name}
                            <span className="user-tag">{req.from_user.tag}</span>
                          </span>
                          <span className="request-subtext">
                            Pedido de amizade recebido
                          </span>
                        </div>
                      </div>

                      <div className="request-actions">
                        <button
                          className="action-btn accept"
                          onClick={() => handleAccept(req.request_id)}
                          title="Aceitar"
                        >
                          <Check size={18} />
                        </button>
                        <button
                          className="action-btn decline"
                          onClick={() => handleDecline(req.request_id)}
                          title="Recusar"
                        >
                          <X size={18} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {summary.outgoing_requests.length > 0 && (
                <>
                  <h3 className="list-section-header" style={{ marginTop: '24px' }}>
                    PEDIDOS ENVIADOS — {summary.outgoing_requests.length}
                  </h3>
                  <div className="requests-list">
                    {summary.outgoing_requests.map((req) => (
                      <div key={req.request_id} className="request-card">
                        <div className="request-user-info">
                          <div className="avatar-wrapper">
                            <img
                              src={req.to_user.avatar}
                              alt={req.to_user.name}
                              className="user-avatar"
                            />
                            <span className={`status-indicator ${req.to_user.status}`} />
                          </div>
                          <div className="user-details">
                            <span className="user-name">
                              {req.to_user.name}
                              <span className="user-tag">{req.to_user.tag}</span>
                            </span>
                            <span className="request-subtext">
                              Pedido de amizade enviado
                            </span>
                          </div>
                        </div>

                        <div className="request-actions">
                          <button
                            className="action-btn decline"
                            onClick={() => handleDecline(req.request_id)}
                            title="Cancelar pedido"
                          >
                            <X size={18} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* TAB: DISPONÍVEL / TODOS */}
          {(activeTab === 'online' || activeTab === 'all') && (
            <div className="friends-list-section">
              <div className="search-bar-wrapper">
                <input
                  type="text"
                  placeholder="Buscar amigos"
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  className="friends-search-input"
                />
                <Search size={16} className="search-icon" />
              </div>

              <h3 className="list-section-header">
                {activeTab === 'online'
                  ? `DISPONÍVEL — ${filteredFriends.length}`
                  : `TODOS OS AMIGOS — ${filteredFriends.length}`}
              </h3>

              {filteredFriends.length === 0 ? (
                <div className="empty-state">
                  <Users size={48} color="#4e5058" />
                  <p>
                    {activeTab === 'online'
                      ? 'Nenhum amigo online no momento.'
                      : 'Nenhum amigo adicionado ainda.'}
                  </p>
                  <button
                    className="empty-action-btn"
                    onClick={() => setActiveTab('add')}
                  >
                    <UserPlus size={16} />
                    <span>Adicionar amigo</span>
                  </button>
                </div>
              ) : (
                <div className="friends-list">
                  {filteredFriends.map((friend) => (
                    <div
                      key={friend.id}
                      className="friend-row"
                      onClick={() => onOpenDM(friend)}
                    >
                      <div className="friend-info">
                        <div className="avatar-wrapper">
                          <img
                            src={friend.avatar}
                            alt={friend.name}
                            className="user-avatar"
                          />
                          <span className={`status-indicator ${friend.status}`} />
                        </div>
                        <div className="user-details">
                          <div className="name-and-tag">
                            <span className="friend-name">{friend.name}</span>
                            <span className="friend-tag">{friend.tag}</span>
                          </div>
                          <span className="friend-status-text">
                            {friend.customStatus ||
                              (friend.status === 'online'
                                ? 'Disponível'
                                : friend.status === 'idle'
                                ? 'Ausente'
                                : friend.status === 'dnd'
                                ? 'Não perturbe'
                                : 'Offline')}
                          </span>
                        </div>
                      </div>

                      <div
                        className="friend-row-actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          className="friend-action-btn"
                          onClick={() => onOpenDM(friend)}
                          title="Enviar Mensagem"
                        >
                          <MessageSquare size={18} />
                        </button>
                        <button
                          className="friend-action-btn"
                          title="Iniciar Chamada de Voz"
                        >
                          <PhoneCall size={18} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Active Now Sidebar */}
        <div className="active-now-column">
          <h3 className="active-now-title">Ativo agora</h3>
          <div className="active-now-card">
            <h4>Por enquanto está quieto...</h4>
            <p>
              Quando um amigo começar uma atividade, como jogar algo ou conversar por
              voz, mostraremos tudo aqui!
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

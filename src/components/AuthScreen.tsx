import { useState, FC, FormEvent } from 'react';
import { QrCode, Sparkles, ArrowRight, ShieldCheck, User as UserIcon, AlertCircle } from 'lucide-react';
import { User } from '../types';
import { apiGuestLogin, apiLogin, apiRegister, saveLocalSession } from '../services/auth';

interface AuthScreenProps {
  onLogin: (user: User) => void;
}

export const AuthScreen: FC<AuthScreenProps> = ({ onLogin }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');

  // Form states
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === 'register') {
        const res = await apiRegister({
          email,
          username,
          displayName: displayName.trim() ? displayName : undefined,
          password,
        });

        if (res.success && res.token && res.user) {
          saveLocalSession(res.token, res.user);
          onLogin(res.user);
        } else {
          setError(res.error || 'Não foi possível completar o cadastro.');
        }
      } else {
        const res = await apiLogin({
          login: email,
          password,
        });

        if (res.success && res.token && res.user) {
          saveLocalSession(res.token, res.user);
          onLogin(res.user);
        } else {
          setError(res.error || 'E-mail ou senha incorretos.');
        }
      }
    } catch {
      setError('Erro ao se comunicar com o servidor Rust.');
    } finally {
      setLoading(false);
    }
  };

  // Convidados recebem uma sessão temporária do servidor (24h, só em memória)
  const handleDemoGuest = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await apiGuestLogin();
      if (res.success && res.token && res.user) {
        saveLocalSession(res.token, res.user);
        onLogin(res.user);
      } else {
        setError(res.error || 'Não foi possível entrar como convidado.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      {/* Animated Discord Ambient Glow */}
      <div className="auth-glow auth-glow-1" />
      <div className="auth-glow auth-glow-2" />

      {/* Main Login / Register Card */}
      <div className={`auth-card ${mode === 'register' ? 'register-mode' : ''}`}>
        <div className="auth-form-side">
          {mode === 'login' ? (
            <>
              <div className="auth-header">
                <h2 className="auth-title">Boas-vindas de volta!</h2>
                <p className="auth-subtitle">Estamos muito animados em te ver novamente!</p>
              </div>

              {error && (
                <div
                  style={{
                    backgroundColor: 'rgba(242, 63, 67, 0.15)',
                    border: '1px solid rgba(242, 63, 67, 0.4)',
                    color: '#fca5a5',
                    padding: '10px 12px',
                    borderRadius: '4px',
                    fontSize: '13px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '12px',
                  }}
                >
                  <AlertCircle size={16} color="#f23f43" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="auth-form">
                <div className="auth-field">
                  <label className="auth-label">
                    E-mail ou nome de usuário <span className="auth-req">*</span>
                  </label>
                  <input
                    type="text"
                    className="auth-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="seuemail@exemplo.com ou username"
                    autoFocus
                    required
                  />
                </div>

                <div className="auth-field">
                  <label className="auth-label">
                    Senha <span className="auth-req">*</span>
                  </label>
                  <input
                    type="password"
                    className="auth-input"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                  />
                  <a href="#forgot" className="auth-link forgot-link">
                    Esqueceu sua senha?
                  </a>
                </div>

                <button
                  type="submit"
                  className="auth-submit-btn"
                  disabled={loading}
                  style={{ opacity: loading ? 0.7 : 1 }}
                >
                  {loading ? 'Verificando credenciais...' : 'Entrar'}
                </button>

                <button
                  type="button"
                  className="auth-guest-btn"
                  onClick={handleDemoGuest}
                  disabled={loading}
                  title="Entrar direto para testar o app"
                >
                  <Sparkles size={16} />
                  <span>Entrar como Convidado (Acesso Imediato)</span>
                </button>

                <div className="auth-switch-text">
                  <span>Precisando de uma conta? </span>
                  <button
                    type="button"
                    className="auth-switch-btn"
                    onClick={() => {
                      setError(null);
                      setMode('register');
                    }}
                  >
                    Registre-se
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              <div className="auth-header">
                <h2 className="auth-title">Criar uma conta</h2>
                <p className="auth-subtitle">Junte-se à comunidade ultra-rápida do DasCord!</p>
              </div>

              {error && (
                <div
                  style={{
                    backgroundColor: 'rgba(242, 63, 67, 0.15)',
                    border: '1px solid rgba(242, 63, 67, 0.4)',
                    color: '#fca5a5',
                    padding: '10px 12px',
                    borderRadius: '4px',
                    fontSize: '13px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '12px',
                  }}
                >
                  <AlertCircle size={16} color="#f23f43" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="auth-form">
                <div className="auth-field">
                  <label className="auth-label">
                    E-mail <span className="auth-req">*</span>
                  </label>
                  <input
                    type="email"
                    className="auth-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="nome@exemplo.com"
                    autoFocus
                    required
                  />
                </div>

                <div className="auth-field">
                  <label className="auth-label">Nome de Exibição</label>
                  <input
                    type="text"
                    className="auth-input"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Como as pessoas vão te ver"
                  />
                </div>

                <div className="auth-field">
                  <label className="auth-label">
                    Nome de Usuário <span className="auth-req">*</span>
                  </label>
                  <input
                    type="text"
                    className="auth-input"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="ex: leandro.rust"
                    required
                  />
                </div>

                <div className="auth-field">
                  <label className="auth-label">
                    Senha <span className="auth-req">*</span>
                  </label>
                  <input
                    type="password"
                    className="auth-input"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Pelo menos 6 caracteres"
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="auth-submit-btn"
                  disabled={loading}
                  style={{ opacity: loading ? 0.7 : 1 }}
                >
                  {loading ? 'Criando conta no Rust...' : 'Continuar'}
                  {!loading && <ArrowRight size={16} style={{ marginLeft: 6 }} />}
                </button>

                <div className="auth-switch-text">
                  <button
                    type="button"
                    className="auth-switch-btn"
                    onClick={() => {
                      setError(null);
                      setMode('login');
                    }}
                  >
                    Já tem uma conta? Entrar
                  </button>
                </div>
              </form>
            </>
          )}
        </div>

        {/* Right QR Code Side (Classic Discord Feature) */}
        {mode === 'login' && (
          <div className="auth-qr-side">
            <div className="auth-qr-box">
              <div className="auth-qr-code">
                <QrCode size={160} color="#1e1f22" strokeWidth={1.75} />
                <div className="auth-qr-logo">
                  <UserIcon size={18} color="#ffffff" />
                </div>
              </div>
            </div>
            <h3 className="auth-qr-title">Entrar com código QR</h3>
            <p className="auth-qr-desc">
              Escaneie isto com o <strong>app móvel do DasCord</strong> para entrar imediatamente sem digitar senha.
            </p>
            <div className="auth-qr-badge">
              <ShieldCheck size={14} color="#22c55e" />
              <span>Autenticação Segura</span>
            </div>
          </div>
        )}
      </div>

      {/* Footer Branding */}
      <div className="auth-footer-badge">
        <span>DasCord Desktop • Rust + Tauri v2 • Consumo &lt;40MB RAM</span>
      </div>
    </div>
  );
};

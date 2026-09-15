import { useState, FC, FormEvent } from 'react';
import { QrCode, Sparkles, ArrowRight, ShieldCheck, Lightbulb, AlertCircle } from 'lucide-react';
import { User } from '../types';
import { apiGuestLogin, apiLogin, apiRegister, saveLocalSession } from '../services/auth';
import './AuthScreen.css';

interface AuthScreenProps {
  onLogin: (user: User) => void;
}

const AuthError: FC<{ message: string }> = ({ message }) => (
  <div className="auth-error" role="alert">
    <AlertCircle size={16} />
    <span>{message}</span>
  </div>
);

export const AuthScreen: FC<AuthScreenProps> = ({ onLogin }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');

  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMode = (next: 'login' | 'register') => {
    setError(null);
    setMode(next);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res =
        mode === 'register'
          ? await apiRegister({
              email,
              username,
              displayName: displayName.trim() ? displayName : undefined,
              password,
            })
          : await apiLogin({ login: email, password });

      if (res.success && res.token && res.user) {
        saveLocalSession(res.token, res.user);
        onLogin(res.user);
      } else {
        setError(
          res.error || (mode === 'register' ? 'Não foi possível completar o cadastro.' : 'E-mail ou senha incorretos.')
        );
      }
    } catch {
      setError('Erro ao se comunicar com o servidor Rust.');
    } finally {
      setLoading(false);
    }
  };

  // Convidados recebem uma sessão temporária do servidor (24h)
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
      <div className="auth-glow auth-glow-1" />
      <div className="auth-glow auth-glow-2" />

      <div className={`auth-card ${mode === 'register' ? 'register-mode' : ''}`}>
        <div className="auth-form-side">
          <div className="auth-brand">
            <span className="brand-mark">
              <Lightbulb size={16} strokeWidth={2.5} />
            </span>
            DasCord
          </div>

          {mode === 'login' ? (
            <>
              <div className="auth-header">
                <h2 className="auth-title">Boas-vindas de volta!</h2>
                <p className="auth-subtitle">Suas ideias estavam te esperando.</p>
              </div>

              {error && <AuthError message={error} />}

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
                  <a href="#forgot" className="auth-link">
                    Esqueceu sua senha?
                  </a>
                </div>

                <button type="submit" className="auth-submit-btn" disabled={loading}>
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
                  <button type="button" className="auth-switch-btn" onClick={() => switchMode('register')}>
                    Registre-se
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              <div className="auth-header">
                <h2 className="auth-title">Criar uma conta</h2>
                <p className="auth-subtitle">Traga suas ideias para o DasCord.</p>
              </div>

              {error && <AuthError message={error} />}

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
                  <label className="auth-label">Nome de exibição</label>
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
                    Nome de usuário <span className="auth-req">*</span>
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

                <button type="submit" className="auth-submit-btn" disabled={loading}>
                  {loading ? 'Criando conta no Rust...' : 'Continuar'}
                  {!loading && <ArrowRight size={16} />}
                </button>

                <div className="auth-switch-text">
                  <button type="button" className="auth-switch-btn" onClick={() => switchMode('login')}>
                    Já tem uma conta? Entrar
                  </button>
                </div>
              </form>
            </>
          )}
        </div>

        {mode === 'login' && (
          <div className="auth-qr-side">
            <div className="auth-qr-box">
              <div className="auth-qr-code">
                <QrCode size={160} strokeWidth={1.75} />
                <div className="auth-qr-logo">
                  <Lightbulb size={18} strokeWidth={2.5} />
                </div>
              </div>
            </div>
            <h3 className="auth-qr-title">Entrar com código QR</h3>
            <p className="auth-qr-desc">
              Escaneie isto com o <strong>app móvel do DasCord</strong> para entrar imediatamente sem digitar senha.
            </p>
            <div className="auth-qr-badge">
              <ShieldCheck size={14} />
              <span>Autenticação segura</span>
            </div>
          </div>
        )}
      </div>

      <div className="auth-footer-badge">
        <span>DasCord Desktop • Rust + Tauri v2 • Consumo &lt;40MB RAM</span>
      </div>
    </div>
  );
};

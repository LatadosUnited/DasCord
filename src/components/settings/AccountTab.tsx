import { FC, FormEvent, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, KeyRound, MonitorSmartphone } from 'lucide-react';
import { User } from '../../types';
import {
  AccountInfo,
  apiChangePassword,
  apiGetAccount,
  apiRevokeOtherSessions,
  isGuestUser,
} from '../../services/users';

interface AccountTabProps {
  user: User;
}

type Feedback = { type: 'success' | 'error'; message: string } | null;

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return '••••••';
  return `${'•'.repeat(Math.max(name.length, 4))}@${domain}`;
}

export const AccountTab: FC<AccountTabProps> = ({ user }) => {
  const guest = isGuestUser(user);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showEmail, setShowEmail] = useState(false);

  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordFeedback, setPasswordFeedback] = useState<Feedback>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  const [sessionsFeedback, setSessionsFeedback] = useState<Feedback>(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    if (guest) return;
    apiGetAccount().then((res) => {
      if (res.ok) setAccount(res.data);
      else setLoadError(res.error);
    });
  }, [guest]);

  const resetPasswordForm = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordOpen(false);
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordFeedback(null);

    if (newPassword.length < 6) {
      setPasswordFeedback({ type: 'error', message: 'A nova senha deve conter no mínimo 6 caracteres.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordFeedback({ type: 'error', message: 'A confirmação não é igual à nova senha.' });
      return;
    }
    if (newPassword === currentPassword) {
      setPasswordFeedback({ type: 'error', message: 'A nova senha precisa ser diferente da atual.' });
      return;
    }

    setSavingPassword(true);
    const res = await apiChangePassword(currentPassword, newPassword);
    setSavingPassword(false);

    if (!res.ok) {
      setPasswordFeedback({ type: 'error', message: res.error });
      return;
    }
    const revoked = res.data.revokedSessions;
    setPasswordFeedback({
      type: 'success',
      message:
        revoked > 0
          ? `Senha alterada. ${revoked} ${revoked === 1 ? 'outra sessão foi encerrada' : 'outras sessões foram encerradas'}.`
          : 'Senha alterada com sucesso.',
    });
    setAccount((prev) => (prev ? { ...prev, otherSessions: 0 } : prev));
    resetPasswordForm();
  };

  const handleRevokeSessions = async () => {
    setSessionsFeedback(null);
    setRevoking(true);
    const res = await apiRevokeOtherSessions();
    setRevoking(false);

    if (!res.ok) {
      setSessionsFeedback({ type: 'error', message: res.error });
      return;
    }
    setAccount((prev) => (prev ? { ...prev, otherSessions: 0 } : prev));
    setSessionsFeedback({ type: 'success', message: 'As outras sessões foram encerradas.' });
  };

  if (guest) {
    return (
      <div className="settings-section">
        <div className="settings-notice">
          <AlertCircle size={18} />
          <span>
            Você entrou como convidado. Crie uma conta para ter e-mail, senha, avatar e amigos. A sessão de
            convidado expira em 24 horas.
          </span>
        </div>
      </div>
    );
  }

  const otherSessions = account?.otherSessions ?? 0;

  return (
    <div className="settings-section">
      <div className="account-card">
        <div className="account-banner" />
        <div className="account-identity">
          <div className="avatar-wrapper account-avatar">
            <img src={user.avatar} alt={user.name} className="avatar-img" />
            <div className={`status-dot ${user.status}`} />
          </div>
          <div className="account-names">
            <span className="account-display-name">{user.name}</span>
            <span className="account-handle">
              {account ? `${account.username}${account.tag}` : user.tag}
            </span>
          </div>
        </div>

        <div className="account-fields">
          {loadError && <div className="settings-feedback error">{loadError}</div>}

          <div className="account-field">
            <div>
              <div className="settings-label">Nome de usuário</div>
              <div className="account-value">{account ? `${account.username}${account.tag}` : '...'}</div>
            </div>
          </div>

          <div className="account-field">
            <div>
              <div className="settings-label">E-mail</div>
              <div className="account-value">
                {account ? (showEmail ? account.email : maskEmail(account.email)) : '...'}
                {account && (
                  <button className="link-btn" onClick={() => setShowEmail((v) => !v)}>
                    {showEmail ? 'Ocultar' : 'Mostrar'}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="account-field">
            <div>
              <div className="settings-label">Membro desde</div>
              <div className="account-value">
                {account ? new Date(account.createdAt).toLocaleDateString('pt-BR', { dateStyle: 'long' }) : '...'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <section className="settings-group">
        <h3 className="settings-group-title">
          <KeyRound size={16} />
          Senha
        </h3>

        {!passwordOpen ? (
          <button
            className="btn fit"
            onClick={() => {
              setPasswordFeedback(null);
              setPasswordOpen(true);
            }}
          >
            Alterar senha
          </button>
        ) : (
          <form className="settings-form" onSubmit={handleChangePassword}>
            <label className="settings-field">
              <span className="settings-label">Senha atual</span>
              <input
                type="password"
                className="input"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                autoFocus
              />
            </label>
            <label className="settings-field">
              <span className="settings-label">Nova senha</span>
              <input
                type="password"
                className="input"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Pelo menos 6 caracteres"
                required
              />
            </label>
            <label className="settings-field">
              <span className="settings-label">Confirmar nova senha</span>
              <input
                type="password"
                className="input"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </label>
            <p className="settings-help">Ao trocar a senha, todas as outras sessões abertas serão encerradas.</p>
            <div className="settings-actions">
              <button type="button" className="btn secondary" onClick={resetPasswordForm}>
                Cancelar
              </button>
              <button type="submit" className="btn" disabled={savingPassword}>
                {savingPassword ? 'Salvando...' : 'Salvar nova senha'}
              </button>
            </div>
          </form>
        )}

        {passwordFeedback && <FeedbackBox feedback={passwordFeedback} />}
      </section>

      <section className="settings-group">
        <h3 className="settings-group-title">
          <MonitorSmartphone size={16} />
          Sessões
        </h3>
        <p className="settings-help">
          {otherSessions === 0
            ? 'Você não está conectado em nenhum outro dispositivo.'
            : `Você está conectado em mais ${otherSessions} ${otherSessions === 1 ? 'dispositivo' : 'dispositivos'}.`}
        </p>
        <button
          className="btn secondary fit"
          onClick={handleRevokeSessions}
          disabled={revoking || otherSessions === 0}
        >
          {revoking ? 'Encerrando...' : 'Encerrar as outras sessões'}
        </button>
        {sessionsFeedback && <FeedbackBox feedback={sessionsFeedback} />}
      </section>
    </div>
  );
};

const FeedbackBox: FC<{ feedback: NonNullable<Feedback> }> = ({ feedback }) => (
  <div className={`settings-feedback ${feedback.type}`}>
    {feedback.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
    <span>{feedback.message}</span>
  </div>
);

import { FC, useEffect, useState } from 'react';
import { AlertCircle, Check, Copy } from 'lucide-react';
import { Server, User } from '../../types';
import { isGuestUser } from '../../services/users';
import { INVITE_AGE_OPTIONS, INVITE_USES_OPTIONS, Invite, apiCreateInvite } from '../../services/servers';
import { FormFeedback, Modal } from '../Modal';
import './servers.css';

const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60;

interface InviteModalProps {
  server: Server;
  currentUser: User;
  onClose: () => void;
}

// <select> só trabalha com texto: '' representa null (nunca expira / sem limite)
const toOptionValue = (value: number | null) => (value === null ? '' : String(value));
const fromOptionValue = (value: string) => (value === '' ? null : Number(value));

function describeInvite(maxAge: number | null, maxUses: number | null): string {
  const age = INVITE_AGE_OPTIONS.find((o) => o.value === maxAge)?.label.toLowerCase();
  const uses = maxUses === null ? null : `${maxUses} ${maxUses === 1 ? 'uso' : 'usos'}`;
  if (maxAge === null) {
    return uses ? `Este convite não expira, mas só vale para ${uses}.` : 'Este convite não expira e não tem limite de usos.';
  }
  return uses ? `Este convite expira em ${age} ou depois de ${uses}.` : `Este convite expira em ${age}.`;
}

/** Gera um convite para o servidor; mudar as opções gera um novo código */
export const InviteModal: FC<InviteModalProps> = ({ server, currentUser, onClose }) => {
  const guest = isGuestUser(currentUser);
  const [maxAge, setMaxAge] = useState<number | null>(DEFAULT_MAX_AGE);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (guest) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCopied(false);
    apiCreateInvite(server.id, maxAge, maxUses).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        setInvite(res.data.invite);
      } else {
        setInvite(null);
        setError(res.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [guest, server.id, maxAge, maxUses]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyCode = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
    } catch {
      setError('Não foi possível copiar. Selecione o código e copie manualmente.');
    }
  };

  return (
    <Modal
      title={`Convidar para ${server.name}`}
      subtitle="Mande o código para quem você quer chamar. A pessoa clica em + na lista de servidores e escolhe “Entrar com um convite”."
      onClose={onClose}
    >
      {guest ? (
        <div className="form-notice">
          <AlertCircle size={18} />
          <span>Convidados não podem criar convites. Crie uma conta para chamar pessoas.</span>
        </div>
      ) : (
        <>
          <div className="form-field">
            <span className="form-label">Código do convite</span>
            <div className="invite-code-row">
              <input
                className="input invite-code"
                value={loading ? 'Gerando...' : invite?.code ?? ''}
                onFocus={(e) => e.target.select()}
                aria-label="Código do convite"
                readOnly
              />
              <button className={`btn ${copied ? 'success' : ''}`} onClick={copyCode} disabled={!invite || loading}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
                <span>{copied ? 'Copiado' : 'Copiar'}</span>
              </button>
            </div>
            <span className="form-help">{describeInvite(maxAge, maxUses)}</span>
          </div>

          <div className="invite-options">
            <label className="form-field">
              <span className="form-label">Expira depois de</span>
              <select
                className="input"
                value={toOptionValue(maxAge)}
                onChange={(e) => setMaxAge(fromOptionValue(e.target.value))}
                disabled={loading}
              >
                {INVITE_AGE_OPTIONS.map((option) => (
                  <option key={option.label} value={toOptionValue(option.value)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span className="form-label">Número máximo de usos</span>
              <select
                className="input"
                value={toOptionValue(maxUses)}
                onChange={(e) => setMaxUses(fromOptionValue(e.target.value))}
                disabled={loading}
              >
                {INVITE_USES_OPTIONS.map((option) => (
                  <option key={option.label} value={toOptionValue(option.value)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error && <FormFeedback kind="error">{error}</FormFeedback>}
        </>
      )}
    </Modal>
  );
};

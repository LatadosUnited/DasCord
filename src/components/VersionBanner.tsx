import { FC, useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { APP_VERSION, MIN_SERVER_VERSION, ServerVersionInfo, findVersionIssue } from '../services/version';
import './VersionBanner.css';

interface VersionBannerProps {
  serverVersion: ServerVersionInfo | null;
}

/** Aviso flutuante quando o app e o servidor estão em versões incompatíveis */
export const VersionBanner: FC<VersionBannerProps> = ({ serverVersion }) => {
  const issue = serverVersion ? findVersionIssue(serverVersion) : null;
  const issueKey = issue ? JSON.stringify(issue) : null;
  // Dispensar vale só para este problema: se a situação mudar, o aviso volta
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  if (!issue || dismissedKey === issueKey) return null;

  return (
    <div className="version-banner" role="alert">
      <AlertCircle size={18} />
      <span className="version-banner-text">
        {issue.kind === 'client-outdated' ? (
          <>
            Este DasCord (v{APP_VERSION}) é mais antigo do que o servidor aceita.{' '}
            <strong>Atualize para a v{issue.required} ou mais recente</strong> para evitar erros.
          </>
        ) : (
          <>
            O servidor está {issue.server ? `na v${issue.server}` : 'numa versão antiga'}, e este app (v{APP_VERSION})
            precisa da <strong>v{MIN_SERVER_VERSION} ou mais recente</strong>. Algumas funções podem falhar.
          </>
        )}
      </span>
      <button className="icon-btn" onClick={() => setDismissedKey(issueKey)} title="Dispensar aviso">
        <X size={16} />
      </button>
    </div>
  );
};

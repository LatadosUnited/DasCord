import { FC } from 'react';
import { Download, X } from 'lucide-react';
import { AppUpdateState } from '../hooks/useAppUpdate';
import './UpdateBanner.css';

/** Aviso flutuante de versão nova do app, com o download acontecendo ali mesmo */
export const UpdateBanner: FC<{ state: AppUpdateState }> = ({ state }) => {
  const { update, progress, installing, error, install, dismiss } = state;
  if (!update) return null;

  const percent = progress === null ? null : Math.round(progress * 100);

  return (
    <div className="update-banner" role="status">
      <Download size={18} />
      <div className="update-banner-text">
        <strong>DasCord v{update.version} disponível.</strong>{' '}
        {installing ? (
          percent === null ? 'Baixando...' : `Baixando... ${percent}%`
        ) : error ? (
          <>Não deu para atualizar: {error}</>
        ) : (
          'O app reinicia sozinho ao terminar.'
        )}
      </div>
      {!installing && (
        <button className="update-banner-action" onClick={install}>
          {error ? 'Tentar de novo' : 'Atualizar agora'}
        </button>
      )}
      {installing && percent !== null && (
        <div className="update-banner-progress" aria-hidden="true">
          <div className="update-banner-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      {!installing && (
        <button className="icon-btn" onClick={dismiss} title="Agora não">
          <X size={16} />
        </button>
      )}
    </div>
  );
};

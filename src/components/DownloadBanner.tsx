import { FC } from 'react';
import { Monitor, X } from 'lucide-react';
import { DesktopDownloadState } from '../hooks/useDesktopDownload';
// Mesmo aviso flutuante da atualização: os dois nunca aparecem juntos
import './UpdateBanner.css';

/** Convite para instalar o app desktop, só para quem usa pelo navegador */
export const DownloadBanner: FC<{ state: DesktopDownloadState }> = ({ state }) => {
  const { download, dismiss } = state;
  if (!download) return null;

  return (
    <div className="update-banner" role="status">
      <Monitor size={18} />
      <div className="update-banner-text">
        <strong>DasCord para Windows.</strong> Controle remoto, Jogar Junto e atualizações
        automáticas só existem no app.
      </div>
      {/* Tirar o link da tela no próprio clique poderia cancelar o download */}
      <a
        className="update-banner-action"
        href={download.url}
        download
        onClick={() => setTimeout(dismiss, 0)}
      >
        Baixar v{download.version}
      </a>
      <button className="icon-btn" onClick={dismiss} title="Agora não">
        <X size={16} />
      </button>
    </div>
  );
};

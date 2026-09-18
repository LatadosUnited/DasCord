import { useCallback, useEffect, useState } from 'react';
import {
  DesktopDownload,
  fetchDesktopDownload,
  rememberDismissed,
  wasDismissed,
} from '../services/appDownload';

export interface DesktopDownloadState {
  /** null: dentro do app desktop, sem instalador para esta plataforma ou já dispensado */
  download: DesktopDownload | null;
  dismiss: () => void;
}

/** Oferece o app desktop a quem está no navegador */
export function useDesktopDownload(): DesktopDownloadState {
  const [download, setDownload] = useState<DesktopDownload | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDesktopDownload().then((found) => {
      if (!cancelled && found && !wasDismissed(found.version)) setDownload(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    setDownload((current) => {
      if (current) rememberDismissed(current.version);
      return null;
    });
  }, []);

  return { download, dismiss };
}

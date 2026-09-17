import { useCallback, useEffect, useState } from 'react';
import { Update, checkForAppUpdate, downloadAndInstall } from '../services/appUpdate';

/** De quanto em quanto tempo o app volta a perguntar, para quem fica dias sem fechar */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AppUpdateState {
  /** null: nada novo, ou o app está no navegador */
  update: Update | null;
  /** 0..1 durante o download; null antes de começar ou quando o tamanho é desconhecido */
  progress: number | null;
  installing: boolean;
  error: string | null;
  install: () => void;
  dismiss: () => void;
}

/** Procura versão nova do app desktop e cuida do download quando o usuário aceita */
export function useAppUpdate(): AppUpdateState {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const look = () => {
      checkForAppUpdate().then((found) => {
        // Já baixando: trocar o objeto no meio do caminho atrapalharia a instalação
        if (!cancelled && found) setUpdate((current) => current ?? found);
      });
    };
    look();
    const timer = setInterval(look, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const install = useCallback(() => {
    if (!update || installing) return;
    setInstalling(true);
    setError(null);
    downloadAndInstall(update, setProgress).catch((e) => {
      setInstalling(false);
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [update, installing]);

  // Dispensar vale só desta vez: na próxima consulta o aviso volta
  const dismiss = useCallback(() => setUpdate(null), []);

  return { update, progress, installing, error, install, dismiss };
}

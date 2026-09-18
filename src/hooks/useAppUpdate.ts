import { useCallback, useEffect, useState } from 'react';
import { Update, checkForAppUpdate, downloadAndInstall } from '../services/appUpdate';
import { RUNS_IN_TAURI } from '../services/appWindow';

/**
 * De quanto em quanto tempo o app volta a perguntar, para quem não fecha o app.
 * A pergunta é barata (o servidor só lê o latest.json), e uma versão publicada
 * precisa chegar em minutos, não no dia seguinte.
 */
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** Resultado da última verificação pedida pelo usuário; a periódica não mexe aqui */
export type UpdateCheckStatus = 'idle' | 'checking' | 'up-to-date' | 'error';

export interface AppUpdateState {
  /** null: nada novo, ou o app está no navegador */
  update: Update | null;
  /** 0..1 durante o download; null antes de começar ou quando o tamanho é desconhecido */
  progress: number | null;
  installing: boolean;
  error: string | null;
  checkStatus: UpdateCheckStatus;
  install: () => void;
  dismiss: () => void;
  /** Pergunta agora, sem esperar a próxima consulta periódica */
  checkNow: () => void;
}

/** Procura versão nova do app desktop e cuida do download quando o usuário aceita */
export function useAppUpdate(): AppUpdateState {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkStatus, setCheckStatus] = useState<UpdateCheckStatus>('idle');

  useEffect(() => {
    if (!RUNS_IN_TAURI) return;
    let cancelled = false;
    const look = () => {
      checkForAppUpdate()
        .then((found) => {
          // Já baixando: trocar o objeto no meio do caminho atrapalharia a instalação
          if (!cancelled && found) setUpdate((current) => current ?? found);
        })
        // Na consulta de fundo, servidor fora do ar não merece aviso: a próxima tenta de novo
        .catch(() => {});
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

  const checkNow = useCallback(() => {
    if (!RUNS_IN_TAURI || installing || checkStatus === 'checking') return;
    setCheckStatus('checking');
    checkForAppUpdate()
      .then((found) => {
        // Traz de volta até um aviso dispensado: agora foi a pessoa que pediu
        if (found) setUpdate((current) => current ?? found);
        setCheckStatus(found ? 'idle' : 'up-to-date');
      })
      .catch(() => setCheckStatus('error'));
  }, [installing, checkStatus]);

  // Dispensar vale só desta vez: na próxima consulta o aviso volta
  const dismiss = useCallback(() => setUpdate(null), []);

  return { update, progress, installing, error, checkStatus, install, dismiss, checkNow };
}

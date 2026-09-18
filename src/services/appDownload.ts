// Instalador do app desktop para quem usa o DasCord pelo navegador. O servidor
// entrega o mesmo arquivo que o updater usa, então quem instala por aqui já
// recebe as próximas versões sozinho.

import { API_URL } from './config';
import { RUNS_IN_TAURI } from './appWindow';

export interface DesktopDownload {
  version: string;
  url: string;
}

const DISMISSED_KEY = 'dascord.download.dispensado';

/** Hoje só há instalador de Windows; nas outras plataformas não há o que oferecer */
function platform(): string | null {
  return /Windows/i.test(navigator.userAgent) ? 'windows/x86_64' : null;
}

/** null dentro do app desktop, fora do Windows ou quando nada foi publicado */
export async function fetchDesktopDownload(): Promise<DesktopDownload | null> {
  const target = platform();
  if (RUNS_IN_TAURI || !target) return null;
  try {
    const res = await fetch(`${API_URL}/api/download/${target}`);
    if (res.status !== 200) return null;
    return (await res.json()) as DesktopDownload;
  } catch {
    return null;
  }
}

// A versão dispensada fica guardada: uma versão nova volta a oferecer o app
export function wasDismissed(version: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === version;
  } catch {
    return false;
  }
}

export function rememberDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Sem armazenamento o aviso só volta na próxima visita
  }
}

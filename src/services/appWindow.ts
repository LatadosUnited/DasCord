// Os controles da janela (minimizar, maximizar, fechar) da barra de título do app.
// No navegador nada disso existe: a barra esconde os botões em vez de oferecer
// um clique que não faz nada.

import { isTauri } from '@tauri-apps/api/core';

/** true só quando o app roda dentro do Tauri, não numa aba do navegador */
export const RUNS_IN_TAURI = isTauri();

async function janela() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export async function minimizeWindow(): Promise<void> {
  (await janela()).minimize();
}

/** Maximiza ou volta ao tamanho anterior, conforme o estado atual */
export async function toggleMaximizeWindow(): Promise<void> {
  (await janela()).toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  (await janela()).close();
}

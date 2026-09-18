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

/**
 * Tela cheia de verdade: no app, a janela ocupa o monitor inteiro sem precisar de clique
 * (o controle chega quando a outra pessoa aceita, não quando esta clica). No navegador,
 * o pedido pode ser recusado por falta de clique — aí a tela fica só ocupando a janela.
 */
export async function definirTelaCheia(ativa: boolean): Promise<void> {
  if (RUNS_IN_TAURI) {
    await (await janela()).setFullscreen(ativa);
    return;
  }
  try {
    if (ativa && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    if (!ativa && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    // Sem clique recente o navegador não deixa; a tela ocupa a janela mesmo assim
  }
}

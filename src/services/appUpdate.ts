// Atualização do app desktop. O servidor responde em /api/update/... e o
// instalador só é aceito se estiver assinado com a chave do projeto — quem
// confere é o próprio Tauri, com a chave pública gravada em tauri.conf.json.
//
// No navegador nada disso existe: os imports falham e o app segue sem aviso.

import type { Update } from '@tauri-apps/plugin-updater';

export type { Update };

/** null quando não há versão nova, o app roda no navegador ou o servidor não respondeu */
export async function checkForAppUpdate(): Promise<Update | null> {
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    return await check();
  } catch {
    return null;
  }
}

/**
 * Baixa, instala e reinicia o app. `onProgress` recebe 0..1, ou null enquanto o
 * servidor não disser o tamanho do instalador.
 */
export async function downloadAndInstall(
  update: Update,
  onProgress: (fraction: number | null) => void,
): Promise<void> {
  let total = 0;
  let downloaded = 0;

  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0;
      onProgress(total ? 0 : null);
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength;
      if (total) onProgress(Math.min(downloaded / total, 1));
    } else if (event.event === 'Finished') {
      onProgress(1);
    }
  });

  // No Windows o instalador fecha o app sozinho; nas outras plataformas, reiniciar é aqui
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

import { Attachment } from '../types';
import { IMAGE_TYPES, request } from './api';

/** Imagens do chat podem ser bem maiores que um avatar */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_TYPES = IMAGE_TYPES;

/** Mensagem de erro para um arquivo que não pode ser enviado, ou null se ele serve */
export function attachmentFileError(file: File): string | null {
  if (!ATTACHMENT_TYPES.includes(file.type)) {
    return `${file.name}: por enquanto só dá para enviar imagens (PNG, JPG, GIF ou WebP).`;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${file.name}: imagem grande demais. O máximo é 8 MB.`;
  }
  return null;
}

/**
 * Envia a imagem antes da mensagem. Ela fica guardada sem aparecer para ninguém
 * até a mensagem que a cita ser enviada.
 */
export const apiUploadAttachment = (channelId: string, file: File) =>
  request<{ attachment: Attachment }>(
    `/api/channels/${encodeURIComponent(channelId)}/attachments?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }
  );

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

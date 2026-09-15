import { API_URL } from './config';
import { getLocalSession } from './auth';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Chamada autenticada à API do servidor Rust, com mensagens de erro prontas para exibir */
export async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const { token } = getLocalSession();
  if (!token) return { ok: false, error: 'Sessão expirada. Entre novamente.' };

  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
    });
    if (res.status === 413) {
      return { ok: false, error: 'A imagem é grande demais (máximo de 2 MB).' };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, error: body?.error || `O servidor respondeu com erro ${res.status}.` };
    }
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, error: 'Não foi possível conectar ao servidor.' };
  }
}

export const jsonBody = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Mensagem de erro para um arquivo de imagem inválido, ou null se ele pode ser enviado */
export function imageFileError(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'Formato não suportado. Use PNG, JPG, GIF ou WebP.';
  if (file.size > MAX_IMAGE_BYTES) return 'A imagem é grande demais. O máximo é 2 MB.';
  return null;
}

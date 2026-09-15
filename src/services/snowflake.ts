// DasCord Snowflake Utility (64-bit ID System)
import { API_URL } from './config';

export const DASCORD_EPOCH = 1767225600000n; // 2026-01-01T00:00:00Z

let localSequence = 0n;

/**
 * Gera um Snowflake no cliente (compatível com a estrutura de 64 bits de Rust)
 */
export function generateLocalSnowflake(workerId = 1n, processId = 1n): string {
  const now = BigInt(Date.now());
  const timeDelta = now - DASCORD_EPOCH;

  localSequence = (localSequence + 1n) & 4095n;

  const snowflake =
    (timeDelta << 22n) |
    ((workerId & 31n) << 17n) |
    ((processId & 31n) << 12n) |
    localSequence;

  return snowflake.toString();
}

/**
 * Extrai a data e hora exatas de criação de qualquer ID Snowflake
 */
export function getCreatedAtFromSnowflake(snowflakeId: string): Date {
  try {
    const num = BigInt(snowflakeId);
    const timestampMs = Number((num >> 22n) + DASCORD_EPOCH);
    return new Date(timestampMs);
  } catch {
    return new Date();
  }
}

/**
 * Solicita um Snowflake oficial ao Backend Rust (via Tauri IPC ou Servidor Axum)
 */
export async function getOfficialSnowflake(): Promise<string> {
  // 1. Tenta gerar via Tauri IPC nativo (em < 1ms)
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const id = await invoke<string>('generate_snowflake');
    if (id) return id;
  } catch {
    // Modo web preview
  }

  // 2. Tenta obter via endpoint HTTP do servidor Axum (porta 3001)
  try {
    const res = await fetch(`${API_URL}/api/snowflake`);
    if (res.ok) {
      const data = await res.json();
      return data.id;
    }
  } catch {
    // Servidor offline
  }

  // 3. Fallback para gerador de alta precisão no frontend
  return generateLocalSnowflake();
}

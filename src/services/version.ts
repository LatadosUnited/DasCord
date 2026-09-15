import { API_URL } from './config';

/** Versão deste app, lida do package.json no build */
export const APP_VERSION: string = __APP_VERSION__;

/**
 * Servidor mais antigo que este app sabe usar (servidores e convites chegaram na 0.2.0).
 * Suba quando o app passar a depender de algo novo na API.
 */
export const MIN_SERVER_VERSION = '0.2.0';

export interface ServerVersionInfo {
  /** null: servidor anterior à 0.2.0, que ainda não informava a versão */
  version: string | null;
  minClientVersion: string | null;
}

export type VersionIssue =
  | { kind: 'client-outdated'; required: string }
  | { kind: 'server-outdated'; server: string | null };

/** Compara numericamente ("0.10.0" > "0.9.0"); sufixos como "-beta" são ignorados */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export function findVersionIssue(server: ServerVersionInfo): VersionIssue | null {
  if (!server.version || compareVersions(server.version, MIN_SERVER_VERSION) < 0) {
    return { kind: 'server-outdated', server: server.version };
  }
  if (server.minClientVersion && compareVersions(APP_VERSION, server.minClientVersion) < 0) {
    return { kind: 'client-outdated', required: server.minClientVersion };
  }
  return null;
}

/** null quando o servidor não respondeu: sem conexão não dá para saber a versão */
export async function apiGetServerVersion(): Promise<ServerVersionInfo | null> {
  try {
    const res = await fetch(`${API_URL}/api/version`);
    if (res.status === 404) return { version: null, minClientVersion: null };
    if (!res.ok) return null;
    const body = await res.json();
    return { version: body.version ?? null, minClientVersion: body.minClientVersion ?? null };
  } catch {
    return null;
  }
}

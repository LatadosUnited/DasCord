import { useEffect, useState } from 'react';
import { ServerVersionInfo, apiGetServerVersion } from '../services/version';

/** Versão do servidor: ao abrir o app e a cada reconexão (ele pode ter sido atualizado) */
export function useServerVersion(serverOnline: boolean): ServerVersionInfo | null {
  const [serverVersion, setServerVersion] = useState<ServerVersionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGetServerVersion().then((info) => {
      if (!cancelled && info) setServerVersion(info);
    });
    return () => {
      cancelled = true;
    };
  }, [serverOnline]);

  return serverVersion;
}

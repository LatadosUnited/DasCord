import { useCallback, useEffect, useState } from 'react';
import { SystemStats } from '../types';
import { APP_VERSION } from '../services/version';

/** Números da máquina, lidos do Rust via IPC do Tauri (no navegador, valores de exemplo) */
export function useSystemStats() {
  const [stats, setStats] = useState<SystemStats | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setStats(await invoke<SystemStats>('get_system_stats'));
    } catch {
      // Fallback for direct browser preview
      setStats({
        app_name: 'DasCord (Browser Mode)',
        version: APP_VERSION,
        engine: 'Tauri v2 + Webview2 / V8 Engine',
        ram_usage_mb: 38.4,
        rust_version: 'Rust 1.96.0',
        ping_ms: 1,
      });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { stats, refresh };
}

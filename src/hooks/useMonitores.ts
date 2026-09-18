import { useEffect, useState } from 'react';
import { Monitor, listarMonitores } from '../services/entradaRemota';
import { RUNS_IN_TAURI } from '../services/appWindow';

/** Os monitores desta máquina; vazio no navegador, que não tem como listá-los */
export function useMonitores(): Monitor[] {
  const [monitores, setMonitores] = useState<Monitor[]>([]);

  useEffect(() => {
    if (!RUNS_IN_TAURI) return;
    listarMonitores().then(setMonitores).catch(() => setMonitores([]));
  }, []);

  return monitores;
}

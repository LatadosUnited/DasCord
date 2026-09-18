import { useEffect, useState } from 'react';
import { Latencia, medirLatencia } from '../services/latencia';

/** Atraso da tela de `peerId`, atualizado a cada segundo; `null` enquanto não há medida */
export function useLatencia(peerId: string | null): Latencia | null {
  const [latencia, setLatencia] = useState<Latencia | null>(null);

  useEffect(() => {
    if (!peerId) {
      setLatencia(null);
      return;
    }
    return medirLatencia(peerId, setLatencia);
  }, [peerId]);

  return latencia;
}

import { useEffect, useState } from 'react';
import { MedidaHospedagem, medirHospedagem } from '../services/latencia';

/** Rede, codificação e caminho de cada pessoa que controla esta máquina, a cada segundo */
export function useMedidasHospedagem(peers: string[]): Record<string, MedidaHospedagem> {
  const [medidas, setMedidas] = useState<Record<string, MedidaHospedagem>>({});
  // A lista chega nova a cada render; o que importa é quem está nela
  const chave = peers.join('|');

  useEffect(() => {
    setMedidas({});
    const paradas = chave
      .split('|')
      .filter(Boolean)
      .map((peer) =>
        medirHospedagem(peer, (medida) => setMedidas((antes) => ({ ...antes, [peer]: medida })))
      );
    return () => paradas.forEach((parar) => parar());
  }, [chave]);

  return medidas;
}

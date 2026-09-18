import { useEffect } from 'react';
import { definirTelaCheia } from '../services/appWindow';

/**
 * A janela fica em tela cheia enquanto quem pede estiver montado e `ativa`. Presa à vida
 * do componente de propósito: se a tela remota sumir por qualquer motivo, a janela volta
 * ao normal junto, em vez de ficar em tela cheia mostrando outra coisa.
 */
export function useJanelaTelaCheia(ativa: boolean) {
  useEffect(() => {
    if (!ativa) return;
    definirTelaCheia(true).catch(() => {});
    return () => {
      definirTelaCheia(false).catch(() => {});
    };
  }, [ativa]);
}

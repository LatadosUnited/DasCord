import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONTROLE_NEUTRO,
  EstadoControle,
  atualizarControle,
  conectarControle,
  desconectarControle,
  instalarDriver,
  mesmoEstado,
  padraoParaXInput,
  verificarDriver,
} from '../services/controleVirtual';

/** Enquanto não existe sessão de co-op, o controle de teste é sempre este */
const SLOT_TESTE = 'teste';

export type EstadoDriver = 'verificando' | 'pronto' | 'ausente';

/**
 * Painel de teste do controle virtual: espelha um controle plugado nesta máquina
 * dentro de um Xbox 360 virtual, que é o mesmo caminho que o estado vindo da rede
 * vai percorrer quando a sessão de co-op existir.
 */
export function useControleVirtual() {
  const [driver, setDriver] = useState<EstadoDriver>('verificando');
  const [erro, setErro] = useState<string | null>(null);
  const [ligado, setLigado] = useState(false);
  const [origem, setOrigem] = useState<string | null>(null);
  const [estado, setEstado] = useState<EstadoControle>(CONTROLE_NEUTRO);
  // Ligado depois de abrir o instalador: a aba passa a oferecer "Verificar de novo"
  const [instalando, setInstalando] = useState(false);

  const quadroRef = useRef<number | null>(null);
  const enviadoRef = useRef<EstadoControle>(CONTROLE_NEUTRO);
  // Índice do controle físico, fixado antes de criar o virtual: o virtual também
  // aparece no navigator.getGamepads() desta máquina, e espelhar ele nele mesmo
  // renderia um laço
  const origemRef = useRef<number | null>(null);

  const verificar = useCallback(async () => {
    setDriver('verificando');
    try {
      await verificarDriver();
      setDriver('pronto');
      setErro(null);
    } catch (e) {
      setDriver('ausente');
      setErro((e as Error).message);
    }
  }, []);

  useEffect(() => {
    verificar();
  }, [verificar]);

  /** O instalador roda elevado e em outro processo: aqui só resta pedir para conferir depois */
  const instalar = useCallback(async () => {
    setErro(null);
    try {
      await instalarDriver();
      setInstalando(true);
    } catch (e) {
      setErro((e as Error).message);
    }
  }, []);

  const pararEspelho = useCallback(() => {
    if (quadroRef.current !== null) cancelAnimationFrame(quadroRef.current);
    quadroRef.current = null;
  }, []);

  const desligar = useCallback(() => {
    pararEspelho();
    origemRef.current = null;
    enviadoRef.current = CONTROLE_NEUTRO;
    setEstado(CONTROLE_NEUTRO);
    setOrigem(null);
    setLigado(false);
    desconectarControle(SLOT_TESTE).catch(() => {});
  }, [pararEspelho]);

  const espelhar = useCallback(() => {
    quadroRef.current = requestAnimationFrame(espelhar);

    const indice = origemRef.current;
    if (indice === null) return;
    const fisico = navigator.getGamepads()[indice];
    if (!fisico) return;

    const atual = padraoParaXInput(fisico);
    setEstado(atual);
    // Um invoke por quadro só faz sentido quando algo mudou: parado, o controle
    // não precisa repetir a mesma coisa 60 vezes por segundo
    if (mesmoEstado(atual, enviadoRef.current)) return;
    enviadoRef.current = atual;
    atualizarControle(SLOT_TESTE, atual).catch((e: Error) => {
      setErro(e.message);
      desligar();
    });
  }, [desligar]);

  const ligar = useCallback(async () => {
    setErro(null);

    const fisico = navigator.getGamepads().find((g): g is Gamepad => !!g);
    if (!fisico) {
      setErro('Nenhum controle encontrado. Plugue um controle e aperte um botão nele — o navegador só o enxerga depois disso.');
      return;
    }

    try {
      // Fixa a origem antes de criar o virtual, senão os dois se confundem
      origemRef.current = fisico.index;
      setOrigem(fisico.id);
      await conectarControle(SLOT_TESTE);
      setLigado(true);
      pararEspelho();
      quadroRef.current = requestAnimationFrame(espelhar);
    } catch (e) {
      origemRef.current = null;
      setOrigem(null);
      setErro((e as Error).message);
    }
  }, [espelhar, pararEspelho]);

  // Fechar as configurações não pode deixar um controle virtual pendurado na máquina
  useEffect(() => desligar, [desligar]);

  return { driver, erro, ligado, origem, estado, instalando, ligar, desligar, instalar, verificar };
}

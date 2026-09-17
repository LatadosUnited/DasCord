// Ponte para os controles virtuais de quem hospeda o co-op. Atravessa daqui para o
// Rust só o estado do controle — teclado e mouse ficam de fora de propósito.
// O formato é o do XInput porque é o que o driver espera; a tradução do padrão do
// navegador para ele mora aqui, para o lado Rust não precisar saber de navegador.
import { invoke } from '@tauri-apps/api/core';
import { RUNS_IN_TAURI } from './appWindow';

/** Máscara de botões do XInput (`wButtons`) */
export const BOTAO = {
  cima: 0x0001,
  baixo: 0x0002,
  esquerda: 0x0004,
  direita: 0x0008,
  start: 0x0010,
  back: 0x0020,
  analogicoEsq: 0x0040,
  analogicoDir: 0x0080,
  lb: 0x0100,
  rb: 0x0200,
  guide: 0x0400,
  a: 0x1000,
  b: 0x2000,
  x: 0x4000,
  y: 0x8000,
} as const;

export interface EstadoControle {
  botoes: number;
  gatilhoEsquerdo: number;
  gatilhoDireito: number;
  analogicoEsqX: number;
  analogicoEsqY: number;
  analogicoDirX: number;
  analogicoDirY: number;
}

export const CONTROLE_NEUTRO: EstadoControle = {
  botoes: 0,
  gatilhoEsquerdo: 0,
  gatilhoDireito: 0,
  analogicoEsqX: 0,
  analogicoEsqY: 0,
  analogicoDirX: 0,
  analogicoDirY: 0,
};

/** Ordem dos botões no layout `standard` da Gamepad API, traduzida para a máscara do XInput */
const ORDEM_PADRAO = [
  BOTAO.a,
  BOTAO.b,
  BOTAO.x,
  BOTAO.y,
  BOTAO.lb,
  BOTAO.rb,
  0, // gatilho esquerdo: no XInput é eixo, não botão
  0, // gatilho direito
  BOTAO.back,
  BOTAO.start,
  BOTAO.analogicoEsq,
  BOTAO.analogicoDir,
  BOTAO.cima,
  BOTAO.baixo,
  BOTAO.esquerda,
  BOTAO.direita,
  BOTAO.guide,
];

const paraEixo = (valor: number) => Math.max(-32768, Math.min(32767, Math.round(valor * 32767)));
const paraGatilho = (valor: number) => Math.max(0, Math.min(255, Math.round(valor * 255)));

/** Converte o que a Gamepad API entrega no formato que o driver espera */
export function padraoParaXInput(gamepad: Gamepad): EstadoControle {
  let botoes = 0;
  ORDEM_PADRAO.forEach((mascara, i) => {
    if (mascara && gamepad.buttons[i]?.pressed) botoes |= mascara;
  });

  return {
    botoes,
    gatilhoEsquerdo: paraGatilho(gamepad.buttons[6]?.value ?? 0),
    gatilhoDireito: paraGatilho(gamepad.buttons[7]?.value ?? 0),
    analogicoEsqX: paraEixo(gamepad.axes[0] ?? 0),
    // O eixo Y da Gamepad API cresce para baixo e o do XInput para cima
    analogicoEsqY: paraEixo(-(gamepad.axes[1] ?? 0)),
    analogicoDirX: paraEixo(gamepad.axes[2] ?? 0),
    analogicoDirY: paraEixo(-(gamepad.axes[3] ?? 0)),
  };
}

export const mesmoEstado = (a: EstadoControle, b: EstadoControle) =>
  a.botoes === b.botoes &&
  a.gatilhoEsquerdo === b.gatilhoEsquerdo &&
  a.gatilhoDireito === b.gatilhoDireito &&
  a.analogicoEsqX === b.analogicoEsqX &&
  a.analogicoEsqY === b.analogicoEsqY &&
  a.analogicoDirX === b.analogicoDirX &&
  a.analogicoDirY === b.analogicoDirY;

const SO_NO_APP = 'Os controles virtuais só funcionam no aplicativo instalado.';

/** Responde se o driver ViGEmBus está instalado, sem criar controle nenhum */
export async function verificarDriver(): Promise<void> {
  if (!RUNS_IN_TAURI) throw new Error(SO_NO_APP);
  await invoke('controle_virtual_verificar');
}

/** `slot` identifica de quem é o controle; numa sessão real, o participante */
export async function conectarControle(slot: string): Promise<void> {
  if (!RUNS_IN_TAURI) throw new Error(SO_NO_APP);
  await invoke('controle_virtual_conectar', { slot });
}

export async function atualizarControle(slot: string, entrada: EstadoControle): Promise<void> {
  await invoke('controle_virtual_atualizar', { slot, entrada });
}

export async function desconectarControle(slot: string): Promise<void> {
  if (!RUNS_IN_TAURI) return;
  await invoke('controle_virtual_desconectar', { slot });
}

/**
 * Abre o instalador do ViGEmBus que veio junto do app. Volta assim que o instalador
 * abre — quem diz se o driver entrou é o `verificarDriver()` depois.
 */
export async function instalarDriver(): Promise<void> {
  if (!RUNS_IN_TAURI) throw new Error(SO_NO_APP);
  await invoke('controle_virtual_instalar_driver');
}

export async function desconectarTodosOsControles(): Promise<void> {
  if (!RUNS_IN_TAURI) return;
  await invoke('controle_virtual_desconectar_todos');
}

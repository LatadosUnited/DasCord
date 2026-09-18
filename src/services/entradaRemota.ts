// Ponte para o teclado e o mouse de quem hospeda. A tradução do teclado mora aqui:
// o navegador entrega `KeyboardEvent.code` (a tecla pela posição física, não pela letra
// impressa), e o Windows quer o código de tecla virtual. Traduzindo por posição, o
// layout de quem controla deixa de interferir — ABNT2 aperta a tecla que o host tem.
import { invoke } from '@tauri-apps/api/core';
import { RUNS_IN_TAURI } from './appWindow';

export interface Monitor {
  nome: string;
  x: number;
  y: number;
  largura: number;
  altura: number;
  escala: number;
  principal: boolean;
}

/** Códigos de tecla virtual do Windows que não seguem nenhuma sequência */
const VK_AVULSO: Record<string, number> = {
  Escape: 0x1b,
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  NumpadEnter: 0x0d,
  Space: 0x20,
  CapsLock: 0x14,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  ContextMenu: 0x5d,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  PrintScreen: 0x2c,
  ScrollLock: 0x91,
  Pause: 0x13,
  NumLock: 0x90,
  NumpadMultiply: 0x6a,
  NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d,
  NumpadDecimal: 0x6e,
  NumpadDivide: 0x6f,
  Minus: 0xbd,
  Equal: 0xbb,
  BracketLeft: 0xdb,
  BracketRight: 0xdd,
  Backslash: 0xdc,
  Semicolon: 0xba,
  Quote: 0xde,
  Backquote: 0xc0,
  Comma: 0xbc,
  Period: 0xbe,
  Slash: 0xbf,
  IntlBackslash: 0xe2,
  // O ABNT2 tem duas teclas que nenhum outro layout tem
  IntlRo: 0xc1,
  NumpadComma: 0xc2,
};

/** As sequências (letras, dígitos, F1..F24 e o teclado numérico) entram calculadas */
const montarTabela = (): Record<string, number> => {
  const tabela: Record<string, number> = { ...VK_AVULSO };
  for (let i = 0; i < 26; i++) tabela[`Key${String.fromCharCode(65 + i)}`] = 0x41 + i;
  for (let i = 0; i < 10; i++) tabela[`Digit${i}`] = 0x30 + i;
  for (let i = 0; i < 10; i++) tabela[`Numpad${i}`] = 0x60 + i;
  for (let i = 1; i <= 24; i++) tabela[`F${i}`] = 0x70 + (i - 1);
  return tabela;
};

const TABELA_VK = montarTabela();

/** `null` para tecla que não sabemos traduzir: melhor não apertar nada do que apertar errado */
export const vkDaTecla = (code: string): number | null => TABELA_VK[code] ?? null;

const SO_NO_APP = 'Controlar a máquina só funciona no aplicativo instalado.';

/** Os monitores desta máquina, para escolher qual está sendo compartilhado */
export async function listarMonitores(): Promise<Monitor[]> {
  if (!RUNS_IN_TAURI) throw new Error(SO_NO_APP);
  return invoke<Monitor[]>('entrada_monitores');
}

/** `x` e `y` vão de 0 a 1 dentro do monitor compartilhado, nunca em pixels */
export async function moverMouse(monitor: string, x: number, y: number): Promise<void> {
  await invoke('entrada_mouse_mover', { monitor, x, y });
}

/** `botao` é o índice do `MouseEvent.button`: 0 esquerdo, 1 meio, 2 direito */
export async function botaoMouse(botao: number, pressionado: boolean): Promise<void> {
  await invoke('entrada_mouse_botao', { botao, pressionado });
}

export async function rodaMouse(horizontal: number, vertical: number): Promise<void> {
  await invoke('entrada_mouse_roda', { horizontal, vertical });
}

export async function tecla(vk: number, pressionado: boolean): Promise<void> {
  await invoke('entrada_tecla', { vk, pressionado });
}

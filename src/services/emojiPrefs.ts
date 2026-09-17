import { useSyncExternalStore } from 'react';

// Preferências do seletor de emoji: ficam só neste computador (localStorage)

export interface EmojiPrefs {
  /** Emojis usados por último, do mais recente para o mais antigo */
  recentes: string[];
  /** 0 = amarelo, 1 a 5 = do tom mais claro ao mais escuro */
  tom: number;
}

/** Uma linha e meia do grid: o suficiente para o que a pessoa usa sempre */
const MAX_RECENTES = 27;

export const TONS_DE_PELE: { tom: number; label: string; amostra: string }[] = [
  { tom: 0, label: 'Padrão', amostra: '✋' },
  { tom: 1, label: 'Pele clara', amostra: '✋🏻' },
  { tom: 2, label: 'Pele morena clara', amostra: '✋🏼' },
  { tom: 3, label: 'Pele morena', amostra: '✋🏽' },
  { tom: 4, label: 'Pele morena escura', amostra: '✋🏾' },
  { tom: 5, label: 'Pele escura', amostra: '✋🏿' },
];

const DEFAULT_PREFS: EmojiPrefs = { recentes: [], tom: 0 };
const STORAGE_KEY = 'dascord_emoji_prefs';

function load(): EmojiPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const salvo = JSON.parse(raw) as Partial<EmojiPrefs>;
    return {
      recentes: Array.isArray(salvo.recentes) ? salvo.recentes.slice(0, MAX_RECENTES) : [],
      tom: typeof salvo.tom === 'number' ? Math.min(Math.max(salvo.tom, 0), 5) : 0,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let current = load();
const listeners = new Set<() => void>();

export function getEmojiPrefs(): EmojiPrefs {
  return current;
}

function salvar(proximo: EmojiPrefs) {
  current = proximo;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // armazenamento indisponível: vale só até fechar o app
  }
  listeners.forEach((cb) => cb());
}

/** Põe o emoji na frente da lista; se já estava lá, ele só sobe de posição */
export function registrarEmojiUsado(char: string) {
  const recentes = [char, ...current.recentes.filter((c) => c !== char)].slice(0, MAX_RECENTES);
  salvar({ ...current, recentes });
}

export function escolherTomDePele(tom: number) {
  salvar({ ...current, tom: Math.min(Math.max(tom, 0), 5) });
}

export function subscribeEmojiPrefs(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useEmojiPrefs(): EmojiPrefs {
  return useSyncExternalStore(subscribeEmojiPrefs, getEmojiPrefs);
}

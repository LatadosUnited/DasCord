// Catálogo de emojis para o seletor: nomes e tags vêm em português do `emojibase-data`.
// São quase 2000 emojis (~770 KB), então o arquivo só é baixado quando o seletor abre
// pela primeira vez — nunca no carregamento do app.
import type { Emoji } from 'emojibase';

export interface EmojiItem {
  /** O emoji em si, já na apresentação colorida */
  char: string;
  hexcode: string;
  label: string;
  /** Rótulo e tags sem acento e em minúsculas; é o que a busca compara */
  termos: string[];
  /** Os 5 tons de pele, do mais claro ao mais escuro; vazio quando o emoji não tem */
  tons: string[];
}

export interface EmojiGroup {
  id: string;
  label: string;
  /** Emoji que representa o grupo na barra de categorias */
  icone: string;
  items: EmojiItem[];
}

/**
 * Grupos do emojibase que mostramos, na ordem do seletor. O grupo 2 (componentes:
 * tons de pele e cores de cabelo soltos) fica de fora: não são emojis de verdade.
 */
const GRUPOS: { grupo: number; id: string; label: string; icone: string }[] = [
  { grupo: 0, id: 'sorrisos', label: 'Sorrisos e emoções', icone: '😀' },
  { grupo: 1, id: 'pessoas', label: 'Pessoas e corpo', icone: '👋' },
  { grupo: 3, id: 'natureza', label: 'Animais e natureza', icone: '🐻' },
  { grupo: 4, id: 'comida', label: 'Comida e bebida', icone: '🍔' },
  { grupo: 5, id: 'viagem', label: 'Viagens e lugares', icone: '✈️' },
  { grupo: 6, id: 'atividades', label: 'Atividades', icone: '⚽' },
  { grupo: 7, id: 'objetos', label: 'Objetos', icone: '💡' },
  { grupo: 8, id: 'simbolos', label: 'Símbolos', icone: '❤️' },
  { grupo: 9, id: 'bandeiras', label: 'Bandeiras', icone: '🏳️' },
];

/**
 * Emoji até esta versão (2017) existe em qualquer sistema e entra sem teste. Acima dela
 * testamos um por um: são ~350 emojis e uns 260 ms, uma vez por sessão. Vale checar de
 * verdade — este Windows 10, por exemplo, não tem nem os da versão 13.
 */
const VERSAO_SEM_TESTE = 10;

let emCache: Promise<EmojiGroup[]> | null = null;

/** Carrega o catálogo uma vez por sessão; chamadas seguintes reaproveitam a promessa */
export function carregarEmojis(): Promise<EmojiGroup[]> {
  emCache ??= import('emojibase-data/pt/data.json')
    .then((modulo) => montarGrupos(modulo.default as unknown as Emoji[]))
    .catch((err) => {
      // Uma falha não pode deixar o seletor travado para sempre
      emCache = null;
      throw err;
    });
  return emCache;
}

function montarGrupos(lista: Emoji[]): EmojiGroup[] {
  const desenha = testeDeFonte();

  return GRUPOS.map(({ grupo, id, label, icone }) => ({
    id,
    label,
    icone,
    items: lista
      .filter((e) => e.group === grupo)
      .filter((e) => parseFloat(String(e.version)) <= VERSAO_SEM_TESTE || !desenha || desenha(texto(e)))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(paraItem),
  })).filter((g) => g.items.length > 0);
}

function paraItem(e: Emoji): EmojiItem {
  return {
    char: texto(e),
    hexcode: e.hexcode,
    label: e.label,
    termos: [e.label, ...(e.tags ?? [])].map(normalizar),
    // Casais e apertos de mão trazem as 25 combinações de dois tons; só nos interessam
    // as variantes de um tom só, que vêm marcadas com um número em `tone`
    tons: (e.skins ?? [])
      .filter((s) => typeof s.tone === 'number')
      .sort((a, b) => (a.tone as number) - (b.tone as number))
      .map(texto),
  };
}

/** `emoji` vem vazio nos que só existem como texto; aí o próprio `text` é o caractere */
function texto(e: Pick<Emoji, 'emoji' | 'text'>): string {
  return e.emoji || e.text;
}

/** Sem acento e em minúsculas, dos dois lados da busca, para "coracao" achar "coração" */
function normalizar(valor: string): string {
  return valor
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Nem toda fonte do sistema tem os emojis mais novos — no Windows 10 eles viram
 * quadradinho. Desenha o emoji num canvas e compara com o quadradinho de um caractere
 * que não existe; se o desenho for igual, é porque a fonte não tem esse emoji.
 * Devolve `null` quando o navegador não deixa distinguir os dois: aí não filtramos nada.
 */
function testeDeFonte(): ((char: string) => boolean) | null {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 20;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    return null;
  }
  if (!ctx) return null;
  const pincel = ctx;
  pincel.textBaseline = 'top';
  pincel.font = '16px sans-serif';

  // O canal alfa basta: interessa a forma desenhada, não a cor
  const assinatura = (valor: string): number => {
    pincel.clearRect(0, 0, 20, 20);
    pincel.fillText(valor, 0, 0);
    const pixels = pincel.getImageData(0, 0, 20, 20).data;
    let hash = 0;
    for (let i = 3; i < pixels.length; i += 4) hash = (hash * 31 + pixels[i]) | 0;
    return hash;
  };

  const ausente = assinatura('\u{10FFFD}'); // codepoint que nunca será atribuído
  if (ausente === assinatura(' ')) return null;

  // Sequência que falta cai em vários glifos lado a lado, em vez de um quadradinho só
  const larguraDeUm = pincel.measureText('😀').width;

  const desenha = (char: string) =>
    pincel.measureText(char).width <= larguraDeUm * 1.4 && assinatura(char) !== ausente;

  // Se o teste reprova emoji que existe em todo lugar, ele está errado: melhor não usar
  if (!desenha('😀') || !desenha('👍') || !desenha('🎉')) return null;
  return desenha;
}

/**
 * Emojis que combinam com a busca, os que batem no começo do nome primeiro.
 * Todas as palavras digitadas precisam aparecer em algum termo do emoji.
 */
export function buscarEmojis(grupos: EmojiGroup[], consulta: string): EmojiItem[] {
  const palavras = normalizar(consulta).split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return [];

  const achados: { item: EmojiItem; peso: number }[] = [];
  for (const grupo of grupos) {
    for (const item of grupo.items) {
      const peso = pontuar(item, palavras);
      if (peso > 0) achados.push({ item, peso });
    }
  }
  return achados.sort((a, b) => b.peso - a.peso).map((a) => a.item);
}

function pontuar(item: EmojiItem, palavras: string[]): number {
  let total = 0;
  for (const palavra of palavras) {
    let melhor = 0;
    for (let i = 0; i < item.termos.length; i++) {
      const termo = item.termos[i];
      // O primeiro termo é o nome do emoji; um acerto no começo do nome tem de ganhar
      // até de um acerto exato em tag, senão "coracao" acha o gato apaixonado primeiro
      const bonus = i === 0 ? 4 : 0;
      if (termo === palavra) melhor = Math.max(melhor, 6 + bonus);
      else if (termo.startsWith(palavra)) melhor = Math.max(melhor, 4 + bonus);
      else if (termo.includes(palavra)) melhor = Math.max(melhor, 1 + bonus);
    }
    if (melhor === 0) return 0;
    total += melhor;
  }
  return total;
}

/**
 * Nome de cada emoji a partir do caractere, tons incluídos. Os recentes são guardados
 * como texto puro, e é assim que o seletor descobre como chamá-los.
 */
export function nomesPorChar(grupos: EmojiGroup[]): Map<string, string> {
  const nomes = new Map<string, string>();
  for (const grupo of grupos) {
    for (const item of grupo.items) {
      nomes.set(item.char, item.label);
      for (const tom of item.tons) nomes.set(tom, item.label);
    }
  }
  return nomes;
}

/** O emoji no tom escolhido; quem não tem variação continua igual */
export function comTom(item: EmojiItem, tom: number): string {
  if (tom <= 0 || item.tons.length === 0) return item.char;
  return item.tons[Math.min(tom, item.tons.length) - 1];
}

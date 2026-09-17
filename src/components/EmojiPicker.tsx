import { useState, useEffect, useMemo, useRef, useCallback, memo, FC } from 'react';
import { Search, Clock } from 'lucide-react';
import {
  EmojiGroup,
  buscarEmojis,
  carregarEmojis,
  comTom,
  nomesPorChar,
} from '../services/emojiCatalog';
import {
  TONS_DE_PELE,
  escolherTomDePele,
  registrarEmojiUsado,
  useEmojiPrefs,
} from '../services/emojiPrefs';
import './EmojiPicker.css';

/** Precisa bater com o `grid-template-columns` do CSS: é o passo das setas para cima e baixo */
const COLUNAS = 9;

/** Um emoji já pronto para ser escolhido, com o tom de pele aplicado */
interface Escolha {
  char: string;
  label: string;
}

interface Secao {
  id: string;
  label: string;
  icone: string;
  escolhas: Escolha[];
  /** Posição da primeira escolha na lista corrida, que é por onde as setas andam */
  base: number;
}

interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  onClose: () => void;
  /**
   * Na barra de reação a escolha é uma só e o seletor fecha; na caixa de mensagem
   * ele fica aberto, porque é comum emendar vários emojis seguidos.
   */
  fecharAoEscolher?: boolean;
}

export const EmojiPicker: FC<EmojiPickerProps> = ({ onPick, onClose, fecharAoEscolher }) => {
  const prefs = useEmojiPrefs();
  const [grupos, setGrupos] = useState<EmojiGroup[] | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [consulta, setConsulta] = useState('');
  const [foco, setFoco] = useState(0);
  const [secaoAtiva, setSecaoAtiva] = useState('');
  const [tomAberto, setTomAberto] = useState(false);

  const painelRef = useRef<HTMLDivElement>(null);
  const roloRef = useRef<HTMLDivElement>(null);
  const buscaRef = useRef<HTMLInputElement>(null);
  const secoesRef = useRef<Map<string, HTMLElement>>(new Map());

  // O catálogo tem quase 2000 emojis e só é baixado aqui, quando o seletor abre
  useEffect(() => {
    let vivo = true;
    carregarEmojis().then(
      (g) => vivo && setGrupos(g),
      () => vivo && setFalhou(true),
    );
    buscaRef.current?.focus();
    return () => {
      vivo = false;
    };
  }, []);

  // Fechar clicando fora, sem brigar com o botão que abriu (ele mesmo alterna)
  useEffect(() => {
    const aoClicar = (e: MouseEvent) => {
      const alvo = e.target as HTMLElement;
      if (painelRef.current?.contains(alvo) || alvo.closest('[data-emoji-toggle]')) return;
      onClose();
    };
    document.addEventListener('mousedown', aoClicar);
    return () => document.removeEventListener('mousedown', aoClicar);
  }, [onClose]);

  const nomes = useMemo(
    () => (grupos ? nomesPorChar(grupos) : new Map<string, string>()),
    [grupos],
  );

  const listasCatalogo = useMemo(() => {
    if (!grupos) return [];
    if (consulta.trim()) {
      const achados = buscarEmojis(grupos, consulta);
      return [
        {
          id: 'busca',
          label: achados.length > 0 ? 'Resultados' : 'Nenhum emoji com esse nome',
          icone: '🔍',
          escolhas: achados.map((i) => ({ char: comTom(i, prefs.tom), label: i.label })),
        },
      ];
    }
    return grupos.map((g) => ({
      id: g.id,
      label: g.label,
      icone: g.icone,
      escolhas: g.items.map((i) => ({ char: comTom(i, prefs.tom), label: i.label })),
    }));
  }, [grupos, consulta, prefs.tom]);

  // Separado do catálogo: escolher um emoji mexe nos recentes, e seria desperdício
  // reconstruir as 2000 escolhas a cada clique com o seletor aberto
  const listaRecentes = useMemo(() => {
    if (prefs.recentes.length === 0) return null;
    return {
      id: 'recentes',
      label: 'Usados recentemente',
      icone: '🕘',
      // Os recentes são guardados só como texto; o nome vem do catálogo
      escolhas: prefs.recentes.map((char) => ({ char, label: nomes.get(char) ?? char })),
    };
  }, [prefs.recentes, nomes]);

  const secoes = useMemo<Secao[]>(() => {
    const listas =
      consulta.trim() || !listaRecentes ? listasCatalogo : [listaRecentes, ...listasCatalogo];
    let base = 0;
    return listas.map((lista) => {
      const secao = { ...lista, base };
      base += lista.escolhas.length;
      return secao;
    });
  }, [listasCatalogo, listaRecentes, consulta]);

  const total = useMemo(() => secoes.reduce((n, s) => n + s.escolhas.length, 0), [secoes]);

  const escolhaEm = useCallback(
    (indice: number): Escolha | undefined => {
      const secao = secoes.find((s) => indice >= s.base && indice < s.base + s.escolhas.length);
      return secao?.escolhas[indice - secao.base];
    },
    [secoes],
  );

  useEffect(() => setFoco(0), [consulta]);

  // Categoria em destaque começa na primeira, e se ajusta quando a lista muda
  useEffect(() => {
    if (secoes.length > 0 && !secoes.some((s) => s.id === secaoAtiva)) setSecaoAtiva(secoes[0].id);
  }, [secoes, secaoAtiva]);

  const escolher = useCallback(
    (char: string) => {
      registrarEmojiUsado(char);
      onPick(char);
      if (fecharAoEscolher) onClose();
    },
    [onPick, onClose, fecharAoEscolher],
  );

  const aoTeclar = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      const escolha = escolhaEm(foco);
      if (escolha) {
        e.preventDefault();
        escolher(escolha.char);
      }
      return;
    }
    // Esquerda e direita só andam no grid quando não há texto para o cursor percorrer
    const passo =
      e.key === 'ArrowDown'
        ? COLUNAS
        : e.key === 'ArrowUp'
          ? -COLUNAS
          : consulta.length > 0
            ? 0
            : e.key === 'ArrowRight'
              ? 1
              : e.key === 'ArrowLeft'
                ? -1
                : 0;
    if (passo === 0) return;
    e.preventDefault();
    setFoco((atual) => Math.min(Math.max(atual + passo, 0), total - 1));
  };

  /** A categoria em destaque é a última seção cujo título já passou pelo topo da lista */
  const aoRolar = () => {
    const rolo = roloRef.current;
    if (!rolo) return;
    let ativa = '';
    for (const secao of secoes) {
      const el = secoesRef.current.get(secao.id);
      if (el && el.offsetTop - rolo.scrollTop <= 8) ativa = secao.id;
    }
    setSecaoAtiva(ativa || secoes[0]?.id || '');
  };

  const irPara = (id: string) => {
    const el = secoesRef.current.get(id);
    if (el && roloRef.current) roloRef.current.scrollTop = el.offsetTop;
    setSecaoAtiva(id);
  };

  const guardarSecao = useCallback((id: string, el: HTMLElement | null) => {
    if (el) secoesRef.current.set(id, el);
    else secoesRef.current.delete(id);
  }, []);

  const tomAtual = TONS_DE_PELE[prefs.tom] ?? TONS_DE_PELE[0];
  const emFoco = escolhaEm(foco);

  return (
    <div className="emoji-picker" ref={painelRef} onKeyDown={aoTeclar}>
      <div className="emoji-picker-busca">
        <Search size={15} />
        <input
          ref={buscaRef}
          type="text"
          placeholder="Buscar emoji"
          value={consulta}
          onChange={(e) => setConsulta(e.target.value)}
        />
      </div>

      {secoes.length > 1 && (
        <div className="emoji-picker-categorias">
          {secoes.map((secao) => (
            <button
              key={secao.id}
              className={secao.id === secaoAtiva ? 'ativa' : ''}
              title={secao.label}
              onClick={() => irPara(secao.id)}
            >
              {secao.id === 'recentes' ? <Clock size={16} /> : secao.icone}
            </button>
          ))}
        </div>
      )}

      <div className="emoji-picker-rolo" ref={roloRef} onScroll={aoRolar}>
        {!grupos && !falhou && <p className="emoji-picker-aviso">Carregando emojis...</p>}
        {falhou && <p className="emoji-picker-aviso">Não foi possível carregar os emojis.</p>}
        {secoes.map((secao) => (
          <SecaoEmojis
            key={secao.id}
            secao={secao}
            // Quem não tem o foco recebe sempre -1, e assim a memoização segura o
            // redesenho: só as duas seções que trocam o foco entre si são refeitas
            focoLocal={
              foco >= secao.base && foco < secao.base + secao.escolhas.length
                ? foco - secao.base
                : -1
            }
            onFoco={setFoco}
            onEscolher={escolher}
            onMedir={guardarSecao}
          />
        ))}
      </div>

      <div className="emoji-picker-rodape">
        <span className="emoji-picker-previa">{emFoco?.char ?? '😀'}</span>
        <span className="emoji-picker-nome">{emFoco?.label ?? 'Escolha um emoji'}</span>
        <div className="emoji-picker-tom">
          <button
            title={`Tom de pele: ${tomAtual.label}`}
            onClick={() => setTomAberto((v) => !v)}
          >
            {tomAtual.amostra}
          </button>
          {tomAberto && (
            <div className="emoji-picker-tons">
              {TONS_DE_PELE.map((t) => (
                <button
                  key={t.tom}
                  className={t.tom === prefs.tom ? 'ativa' : ''}
                  title={t.label}
                  onClick={() => {
                    escolherTomDePele(t.tom);
                    setTomAberto(false);
                  }}
                >
                  {t.amostra}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface SecaoEmojisProps {
  secao: Secao;
  /** Índice do foco dentro desta seção; fora dela quando negativo ou grande demais */
  focoLocal: number;
  onFoco: (indice: number) => void;
  onEscolher: (char: string) => void;
  onMedir: (id: string, el: HTMLElement | null) => void;
}

/**
 * Memoizada de propósito: passar o mouse pelo grid muda o foco o tempo todo, e sem isso
 * cada pixel percorrido redesenharia os quase 2000 botões do seletor inteiro.
 */
const SecaoEmojis = memo<SecaoEmojisProps>(({ secao, focoLocal, onFoco, onEscolher, onMedir }) => {
  const focadoRef = useRef<HTMLButtonElement>(null);
  const dentro = focoLocal >= 0 && focoLocal < secao.escolhas.length;

  useEffect(() => {
    if (dentro) focadoRef.current?.scrollIntoView({ block: 'nearest' });
  }, [dentro, focoLocal]);

  return (
    <section ref={(el) => onMedir(secao.id, el)}>
      <h4>{secao.label}</h4>
      <div className="emoji-picker-grid">
        {secao.escolhas.map((escolha, i) => {
          const focado = dentro && i === focoLocal;
          return (
            <button
              key={`${escolha.char}-${i}`}
              ref={focado ? focadoRef : undefined}
              className={focado ? 'focado' : ''}
              title={escolha.label}
              onMouseEnter={() => onFoco(secao.base + i)}
              onClick={() => onEscolher(escolha.char)}
            >
              {escolha.char}
            </button>
          );
        })}
      </div>
    </section>
  );
});

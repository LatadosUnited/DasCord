// Quanto atraso tem a tela de alguém que assistimos, e de onde ele vem.
//
// Nenhum número daqui depende de relógio sincronizado entre as duas máquinas: a ida e
// volta é medida com o nosso relógio (o `t` do ping volta intacto), e o resto sai das
// estatísticas do WebRTC de cada lado. O que não dá para medir sem relógio comum —
// o tempo de ida sozinho — é estimado como metade da ida e volta, e a tela diz isso.
import { voice } from './voice';
import { TOPICO_CONTROLE, codificarControle } from './entradaProtocolo';
import { conexaoDireta } from './conexaoDireta';

export interface Latencia {
  /** Ida e volta até quem transmite, pelo mesmo servidor que leva a imagem (mediana) */
  idaEVolta: number | null;
  /** Quanto quem transmite leva para codificar um quadro */
  codificacao: number | null;
  /** Quanto o vídeo espera aqui antes de ser mostrado, para absorver oscilação da rede */
  jitterBuffer: number | null;
  decodificacao: number | null;
  fps: number | null;
  /** Fração dos pacotes de vídeo perdidos no último segundo, de 0 a 1 */
  perda: number | null;
  resolucao: string | null;
  codec: string | null;
  /** Passando por relay TURN: um salto a mais, quase sempre mais lento */
  relay: boolean | null;
  /** Estimado: do nosso clique até a máquina de lá (metade da ida e volta) */
  entrada: number | null;
  /** Estimado: de um quadro pronto lá até ele aparecer aqui */
  imagem: number | null;
  /** Estimado: do nosso clique até ver o resultado na tela */
  total: number | null;
  /** Vários pings sem resposta: quem transmite está numa versão que não responde */
  semResposta: boolean;
  /** Direto entre as duas casas, ou passando pelo servidor de mídia */
  caminho: 'direto' | 'servidor';
}

const VAZIA: Latencia = {
  idaEVolta: null,
  codificacao: null,
  jitterBuffer: null,
  decodificacao: null,
  fps: null,
  perda: null,
  resolucao: null,
  codec: null,
  relay: null,
  entrada: null,
  imagem: null,
  total: null,
  semResposta: false,
  caminho: 'servidor',
};

const INTERVALO_MS = 1000;
/** Mediana das últimas medidas: um pico isolado não faz o número pular */
const AMOSTRAS = 5;

/** Uma entrada do relatório do WebRTC: cada tipo traz campos diferentes */
type Estat = Record<string, unknown>;

const num = (s: Estat | null | undefined, chave: string) =>
  typeof s?.[chave] === 'number' ? (s[chave] as number) : undefined;
const txt = (s: Estat | null | undefined, chave: string) =>
  typeof s?.[chave] === 'string' ? (s[chave] as string) : undefined;

const mediana = (valores: number[]) => {
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.floor(ordenados.length / 2)];
};

/** Diferença entre duas leituras acumuladas, por unidade; `null` sem base de comparação */
const porUnidade = (atual: Estat, anterior: Estat | null, soma: string, contagem: string) => {
  if (!anterior) return null;
  const dSoma = (num(atual, soma) ?? 0) - (num(anterior, soma) ?? 0);
  const dContagem = (num(atual, contagem) ?? 0) - (num(anterior, contagem) ?? 0);
  return dContagem > 0 ? (dSoma / dContagem) * 1000 : null;
};

// ---------- Lado de quem mede (quem assiste) ----------

type Ouvinte = (t: number, codificacao: number | null) => void;
const esperandoPong = new Map<string, Set<Ouvinte>>();

/** Chamado por quem recebe o combinado: um pong chegou de `de` */
export function registrarPong(de: string, t: number, codificacao: number | null) {
  esperandoPong.get(de)?.forEach((ouvinte) => ouvinte(t, codificacao));
}

function ouvirPong(peerId: string, ouvinte: Ouvinte): () => void {
  const ouvintes = esperandoPong.get(peerId) ?? new Set<Ouvinte>();
  ouvintes.add(ouvinte);
  esperandoPong.set(peerId, ouvintes);
  return () => {
    ouvintes.delete(ouvinte);
    if (!ouvintes.size) esperandoPong.delete(peerId);
  };
}

/**
 * Pelo caminho que pode perder pacote: retransmitir um ping perdido inflaria a medida.
 * Pela conexão direta quando ela existe, que é por onde a imagem e a entrada vão.
 */
function enviarPing(peerId: string) {
  const ping = codificarControle({ tipo: 'ping', t: performance.now() });
  if (!conexaoDireta.enviarTexto(peerId, new TextDecoder().decode(ping))) {
    voice.enviarEntrada(peerId, ping, false, TOPICO_CONTROLE);
  }
}

/** Mede sem parar a tela de `peerId` até o retorno ser chamado */
export function medirLatencia(peerId: string, aoAtualizar: (latencia: Latencia) => void): () => void {
  const idasEVoltas: number[] = [];
  let codificacao: number | null = null;
  let anterior: Estat | null = null;
  let pingsEnviados = 0;
  let receptorAnterior: RTCRtpReceiver | null = null;

  const pararDeOuvir = ouvirPong(peerId, (t, codificacaoRemota) => {
    idasEVoltas.push(performance.now() - t);
    if (idasEVoltas.length > AMOSTRAS) idasEVoltas.shift();
    codificacao = codificacaoRemota;
  });

  const medir = async () => {
    enviarPing(peerId);
    pingsEnviados++;

    const direto = conexaoDireta.receptor(peerId);
    const receptor = direto ?? voice.getScreenReceiver(peerId);
    if (!receptor) return;
    // Trocou de caminho: os contadores do receptor novo começam do zero, e a diferença
    // com os do antigo daria número sem sentido. As idas e voltas antigas também não valem.
    if (receptor !== receptorAnterior) {
      receptorAnterior = receptor;
      anterior = null;
      idasEVoltas.length = 0;
    }
    const relatorio = await receptor.getStats();

    const porId = new Map<string, Estat>();
    relatorio.forEach((s: Estat) => porId.set(txt(s, 'id') ?? '', s));
    const entradas = Array.from(porId.values());

    const v = entradas.find((s) => s.type === 'inbound-rtp' && s.kind === 'video');
    if (!v) return;
    const codec = txt(porId.get(txt(v, 'codecId') ?? ''), 'mimeType')?.replace('video/', '') ?? null;
    const par = entradas.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
    const relay = par
      ? txt(porId.get(txt(par, 'localCandidateId') ?? ''), 'candidateType') === 'relay' ||
        txt(porId.get(txt(par, 'remoteCandidateId') ?? ''), 'candidateType') === 'relay'
      : null;

    const jitterBuffer = porUnidade(v, anterior, 'jitterBufferDelay', 'jitterBufferEmittedCount');
    const decodificacao = porUnidade(v, anterior, 'totalDecodeTime', 'framesDecoded');
    let perda: number | null = null;
    if (anterior) {
      const perdidos = (num(v, 'packetsLost') ?? 0) - (num(anterior, 'packetsLost') ?? 0);
      const recebidos = (num(v, 'packetsReceived') ?? 0) - (num(anterior, 'packetsReceived') ?? 0);
      perda = perdidos + recebidos > 0 ? Math.max(0, perdidos) / (perdidos + recebidos) : 0;
    }
    anterior = v;

    const idaEVolta = idasEVoltas.length ? mediana(idasEVoltas) : null;
    const fps = num(v, 'framesPerSecond') ?? null;
    const entrada = idaEVolta === null ? null : idaEVolta / 2;
    const imagem =
      idaEVolta === null ? null : idaEVolta / 2 + (codificacao ?? 0) + (jitterBuffer ?? 0) + (decodificacao ?? 0);
    // Mais um quadro: o jogo lá leva até um quadro para desenhar o que chegou
    const quadro = fps ? 1000 / fps : 0;

    aoAtualizar({
      idaEVolta,
      codificacao,
      jitterBuffer,
      decodificacao,
      fps,
      perda,
      resolucao: num(v, 'frameWidth') ? `${num(v, 'frameWidth')}×${num(v, 'frameHeight')}` : null,
      codec,
      relay,
      entrada,
      imagem,
      total: entrada === null || imagem === null ? null : entrada + imagem + quadro,
      semResposta: pingsEnviados >= 3 && idasEVoltas.length === 0,
      caminho: direto ? 'direto' : 'servidor',
    });
  };

  aoAtualizar(VAZIA);
  const intervalo = window.setInterval(() => {
    medir().catch(() => {});
  }, INTERVALO_MS);

  return () => {
    window.clearInterval(intervalo);
    pararDeOuvir();
  };
}

/**
 * O que quem hospeda consegue saber de quem controla. A imagem não volta para cá, então
 * o atraso dela não dá para medir deste lado — mas a rede, a codificação da nossa placa
 * e o caminho, dá.
 */
export interface MedidaHospedagem {
  idaEVolta: number | null;
  codificacao: number | null;
  caminho: 'direto' | 'servidor';
}

export function medirHospedagem(peerId: string, aoAtualizar: (medida: MedidaHospedagem) => void): () => void {
  const idasEVoltas: number[] = [];
  let caminhoAnterior: MedidaHospedagem['caminho'] | null = null;
  const pararDeOuvir = ouvirPong(peerId, (t) => {
    idasEVoltas.push(performance.now() - t);
    if (idasEVoltas.length > AMOSTRAS) idasEVoltas.shift();
  });

  const medir = async () => {
    enviarPing(peerId);
    const emissorDireto = conexaoDireta.emissor(peerId);
    const caminho = emissorDireto ? 'direto' : 'servidor';
    // Trocou de caminho: as idas e voltas do outro não dizem nada sobre este
    if (caminho !== caminhoAnterior) {
      caminhoAnterior = caminho;
      idasEVoltas.length = 0;
    }
    const codificacao = await codificacaoLocal(emissorDireto ?? voice.getScreenSender());
    aoAtualizar({ idaEVolta: idasEVoltas.length ? mediana(idasEVoltas) : null, codificacao, caminho });
  };

  const intervalo = window.setInterval(() => {
    medir().catch(() => {});
  }, INTERVALO_MS);

  return () => {
    window.clearInterval(intervalo);
    pararDeOuvir();
  };
}

const ms = (valor: number | null) => (valor === null ? '—' : `${Math.round(valor)} ms`);

/**
 * Os números do painel em texto corrido, para colar no chat: num teste entre duas casas,
 * quem assiste é quem tem os números, e quem transmite é quem quer vê-los.
 */
export function textoLatencia(l: Latencia, nome: string, versao: string): string {
  const video = [
    l.resolucao,
    l.codec?.toUpperCase(),
    l.fps === null ? null : `${Math.round(l.fps)} fps`,
    l.perda === null ? null : `${(l.perda * 100).toFixed(1)}% perdido`,
  ].filter(Boolean);
  return [
    `DasCord ${versao} — atraso da tela de ${nome} (${new Date().toLocaleString('pt-BR')})`,
    `Caminho: ${l.caminho === 'direto' ? 'direto entre as duas casas' : 'pelo servidor'}${l.relay ? ' (via relay)' : ''}`,
    `Do clique até a tela: ${ms(l.total)}`,
    `  comando chegar lá: ${ms(l.entrada)}`,
    `  imagem chegar aqui: ${ms(l.imagem)}`,
    `Rede, ida e volta: ${ms(l.idaEVolta)}`,
    `Codificar lá: ${ms(l.codificacao)}`,
    `Espera contra oscilação aqui: ${ms(l.jitterBuffer)}`,
    `Decodificar aqui: ${ms(l.decodificacao)}`,
    `Vídeo: ${video.join(' · ') || '—'}`,
    ...(l.semResposta ? ['Sem resposta ao ping: o outro lado provavelmente está numa versão anterior'] : []),
  ].join('\n');
}

// ---------- Lado de quem transmite ----------

/** Um por emissor: SFU e conexão direta codificam cada um a sua cópia */
const codificacaoAnterior = new WeakMap<RTCRtpSender, Estat>();

/**
 * Tempo médio para codificar um quadro da nossa tela desde a última pergunta. Com
 * várias camadas, vale a maior — é ela que quem joga costuma receber.
 */
async function codificacaoLocal(emissor: RTCRtpSender | undefined): Promise<number | null> {
  if (!emissor) return null;
  const relatorio = await emissor.getStats();
  let atual: Estat | null = null;
  relatorio.forEach((s: Estat) => {
    if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
    if (!atual || (num(s, 'frameHeight') ?? 0) > (num(atual, 'frameHeight') ?? 0)) atual = s;
  });
  if (!atual) return null;
  const tempo = porUnidade(atual, codificacaoAnterior.get(emissor) ?? null, 'totalEncodeTime', 'framesEncoded');
  codificacaoAnterior.set(emissor, atual);
  return tempo;
}

let ultimaCodificacao: number | null = null;

/**
 * Responde na hora, com o tempo de codificação da medida anterior: esperar o `getStats()`
 * aqui somaria alguns milissegundos à ida e volta de quem perguntou.
 */
export function responderPing(de: string, t: number) {
  const pong = codificarControle({ tipo: 'pong', t, codificacao: ultimaCodificacao });
  if (!conexaoDireta.enviarTexto(de, new TextDecoder().decode(pong))) {
    voice.enviarEntrada(de, pong, false, TOPICO_CONTROLE);
  }
  codificacaoLocal(conexaoDireta.emissor(de) ?? voice.getScreenSender())
    .then((codificacao) => {
      ultimaCodificacao = codificacao;
    })
    .catch(() => {});
}

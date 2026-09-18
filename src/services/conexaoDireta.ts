// Conexão direta entre quem controla e quem é controlado, sem passar pelo servidor de mídia.
//
// Pelo SFU, o clique vai da casa de um até a VPS e da VPS até a casa do outro, e a imagem
// faz o caminho de volta. Durante o controle, esta conexão leva a tela e a entrada de uma
// casa direto para a outra. Ela é uma otimização, nunca uma dependência: enquanto não fecha,
// ou se cair, tudo continua pelo SFU como antes.
//
// Quem combina a conexão (oferta, resposta, candidatos) é o canal do LiveKit que os dois
// já têm, ponto a ponto. O servidor do DasCord não participa e não precisa saber disto.
import { useSyncExternalStore } from 'react';
import { voice } from './voice';
import { ICE_SERVERS } from './config';
import { TOPICO_DIRETO } from './entradaProtocolo';
import { getVoiceSettings, screenQualityPreset } from './voiceSettings';

/**
 * Só STUN: relay por TURN é justamente o salto a mais que esta conexão existe para evitar.
 * Se só relay funcionar entre as duas casas, fica o SFU, que já está de pé.
 */
const STUN_APENAS: RTCIceServer[] = ICE_SERVERS.filter((s) =>
  [s.urls].flat().every((url) => url.startsWith('stun:'))
);

/** Sem conexão direta até aqui, desiste e segue pelo SFU */
const PRAZO_MS = 10_000;

/**
 * Pacote que perde a vez não serve para nada: fila de movimento velho é atraso puro.
 * Acima disto na fila, o pacote rápido é descartado em vez de enfileirado.
 */
const FILA_MAXIMA_RAPIDO = 16 * 1024;

/**
 * Todo sinal diz de qual conexão é. Sem isso, o "fechar" de uma conexão antiga, chegando
 * logo depois de outra ser aberta no lugar, derrubaria a nova.
 */
type Sinal = { sessao: string } & (
  | { tipo: 'oferta'; sdp: string }
  | { tipo: 'resposta'; sdp: string }
  | { tipo: 'candidato'; candidato: RTCIceCandidateInit }
  | { tipo: 'fechar' }
);

export type CaminhoTela = 'conectando' | 'direto' | 'servidor';

interface Ligacao {
  sessao: string;
  pc: RTCPeerConnection;
  papel: 'hospeda' | 'controla';
  /** Movimento, controle e ping: sem ordem e sem reenvio */
  rapido: RTCDataChannel | null;
  /** Tecla, botão e roda: nada pode se perder */
  confiavel: RTCDataChannel | null;
  video: MediaStream | null;
  emissor: RTCRtpSender | null;
  caminho: CaminhoTela;
  prazo: number;
  /** Candidato que chegou antes da descrição remota; aplicado quando ela chegar */
  pendentes: RTCIceCandidateInit[];
}

export interface EstadoDireto {
  caminho: CaminhoTela;
  video: MediaStream | null;
}

interface Configuracao {
  /** Só aceita oferta de quem de fato nos deu controle */
  aceitarOferta: (de: string) => boolean;
  aoReceber: (de: string, dados: Uint8Array | string) => void;
}

const codificarSinal = (sinal: Sinal) => new TextEncoder().encode(JSON.stringify(sinal));

function decodificarSinal(dados: Uint8Array): Sinal | null {
  try {
    const bruto = JSON.parse(new TextDecoder().decode(dados));
    const sessao = bruto?.sessao;
    if (typeof sessao !== 'string' || !sessao) return null;
    switch (bruto.tipo) {
      case 'oferta':
      case 'resposta':
        return typeof bruto.sdp === 'string' ? { sessao, tipo: bruto.tipo, sdp: bruto.sdp } : null;
      case 'candidato':
        return bruto.candidato && typeof bruto.candidato === 'object'
          ? { sessao, tipo: 'candidato', candidato: bruto.candidato }
          : null;
      case 'fechar':
        return { sessao, tipo: 'fechar' };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** H264 primeiro: quase toda placa de vídeo codifica e decodifica em hardware */
function preferirH264(transceptor: RTCRtpTransceiver) {
  const capacidades = RTCRtpSender.getCapabilities?.('video');
  if (!capacidades || !transceptor.setCodecPreferences) return;
  const h264 = capacidades.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  if (!h264.length) return;
  try {
    transceptor.setCodecPreferences([...h264, ...capacidades.codecs.filter((c) => !h264.includes(c))]);
  } catch {
    // Navegador sem suporte à escolha: negocia o padrão, que também funciona
  }
}

class ConexoesDiretas {
  private ligacoes = new Map<string, Ligacao>();
  private config: Configuracao | null = null;
  private listeners = new Set<() => void>();
  private snapshot: Record<string, EstadoDireto> = {};

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = () => this.snapshot;

  configurar(config: Configuracao) {
    this.config = config;
  }

  // ---------- Quem hospeda abre ----------

  async abrir(peer: string, track: MediaStreamTrack) {
    // Troca em silêncio: avisar o outro lado agora faria ele fechar a conexão nova
    this.encerrar(peer);
    const pc = new RTCPeerConnection({ iceServers: STUN_APENAS });
    const preset = screenQualityPreset(getVoiceSettings().screenQuality);

    const transceptor = pc.addTransceiver(track, {
      direction: 'sendonly',
      sendEncodings: [{ maxBitrate: preset.maxBitrate, maxFramerate: preset.frameRate }],
    });
    preferirH264(transceptor);

    const ligacao = this.nova(peer, pc, 'hospeda', crypto.randomUUID());
    ligacao.emissor = transceptor.sender;
    this.ligarCanal(peer, ligacao, pc.createDataChannel('rapido', { ordered: false, maxRetransmits: 0 }));
    this.ligarCanal(peer, ligacao, pc.createDataChannel('confiavel', { ordered: true }));

    try {
      await pc.setLocalDescription();
      this.sinalizar(peer, { sessao: ligacao.sessao, tipo: 'oferta', sdp: pc.localDescription!.sdp });
    } catch (e) {
      console.warn('Não foi possível abrir a conexão direta:', e);
      this.desistir(peer, ligacao);
    }
  }

  // ---------- O combinado, que chega pelo LiveKit ----------

  receberSinal(de: string, dados: Uint8Array) {
    const sinal = decodificarSinal(dados);
    if (!sinal) return;

    if (sinal.tipo === 'oferta') {
      if (this.config?.aceitarOferta(de)) this.responder(de, sinal.sessao, sinal.sdp);
      return;
    }

    // Resposta, candidato e fechar de uma conexão que já foi trocada: ignorados
    const ligacao = this.ligacoes.get(de);
    if (!ligacao || ligacao.sessao !== sinal.sessao) return;

    switch (sinal.tipo) {
      case 'resposta':
        if (ligacao.papel !== 'hospeda') return;
        ligacao.pc
          .setRemoteDescription({ type: 'answer', sdp: sinal.sdp })
          .then(() => this.aplicarPendentes(ligacao))
          .catch(() => this.desistir(de, ligacao));
        break;
      case 'candidato':
        if (ligacao.pc.remoteDescription) ligacao.pc.addIceCandidate(sinal.candidato).catch(() => {});
        else ligacao.pendentes.push(sinal.candidato);
        break;
      case 'fechar':
        this.encerrar(de);
        break;
    }
  }

  private async responder(peer: string, sessao: string, sdp: string) {
    this.encerrar(peer);
    const pc = new RTCPeerConnection({ iceServers: STUN_APENAS });
    const ligacao = this.nova(peer, pc, 'controla', sessao);

    pc.ondatachannel = (e) => this.ligarCanal(peer, ligacao, e.channel);
    pc.ontrack = (e) => {
      ligacao.video = e.streams[0] ?? new MediaStream([e.track]);
      this.avaliar(peer);
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      this.aplicarPendentes(ligacao);
      await pc.setLocalDescription();
      this.sinalizar(peer, { sessao, tipo: 'resposta', sdp: pc.localDescription!.sdp });
    } catch (e) {
      console.warn('Não foi possível responder à conexão direta:', e);
      this.desistir(peer, ligacao);
    }
  }

  // ---------- Montagem comum aos dois lados ----------

  private nova(peer: string, pc: RTCPeerConnection, papel: Ligacao['papel'], sessao: string): Ligacao {
    const ligacao: Ligacao = {
      sessao,
      pc,
      papel,
      rapido: null,
      confiavel: null,
      video: null,
      emissor: null,
      caminho: 'conectando',
      prazo: window.setTimeout(() => {
        if (ligacao.caminho === 'conectando') this.desistir(peer, ligacao);
      }, PRAZO_MS),
      pendentes: [],
    };
    this.ligacoes.set(peer, ligacao);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.sinalizar(peer, { sessao, tipo: 'candidato', candidato: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.desistir(peer, ligacao);
      else this.avaliar(peer);
    };
    this.notificar();
    return ligacao;
  }

  private ligarCanal(peer: string, ligacao: Ligacao, canal: RTCDataChannel) {
    canal.binaryType = 'arraybuffer';
    if (canal.label === 'rapido') ligacao.rapido = canal;
    else if (canal.label === 'confiavel') ligacao.confiavel = canal;
    else return;

    canal.onopen = () => this.avaliar(peer);
    canal.onclose = () => this.desistir(peer, ligacao);
    // Texto é o combinado (ping e pong); binário é entrada
    canal.onmessage = (e) => {
      this.config?.aoReceber(peer, typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    };
  }

  private aplicarPendentes(ligacao: Ligacao) {
    ligacao.pendentes.forEach((c) => ligacao.pc.addIceCandidate(c).catch(() => {}));
    ligacao.pendentes = [];
  }

  /** Só vira "direto" com tudo de pé: conexão, os dois canais e, para quem controla, o vídeo */
  private avaliar(peer: string) {
    const ligacao = this.ligacoes.get(peer);
    if (!ligacao || ligacao.caminho === 'direto') return;
    const pronta =
      ligacao.pc.connectionState === 'connected' &&
      ligacao.rapido?.readyState === 'open' &&
      ligacao.confiavel?.readyState === 'open' &&
      (ligacao.papel === 'hospeda' || ligacao.video !== null);
    if (!pronta) return;

    window.clearTimeout(ligacao.prazo);
    ligacao.caminho = 'direto';
    if (ligacao.papel === 'controla') {
      // A tela já vem por aqui: pelo SFU seria a mesma imagem, só que mais tarde.
      // Com o dynacast, o LiveKit para de pedir esse vídeo a quem transmite.
      voice.pausarTela(peer, true);
    } else {
      this.manterQuadros(ligacao);
    }
    this.notificar();
  }

  /** Banda apertou: perder resolução, não quadros — num jogo, quadro perdido é engasgo */
  private manterQuadros(ligacao: Ligacao) {
    const emissor = ligacao.emissor;
    if (!emissor) return;
    const parametros = emissor.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
    parametros.degradationPreference = 'maintain-framerate';
    emissor.setParameters(parametros).catch(() => {});
  }

  // ---------- Envio ----------

  /** `false` quando não há conexão direta de pé: quem chamou manda pelo SFU */
  enviar(peer: string, dados: Uint8Array<ArrayBuffer>, confiavel: boolean): boolean {
    const ligacao = this.ligacoes.get(peer);
    if (ligacao?.caminho !== 'direto') return false;
    const canal = confiavel ? ligacao.confiavel : ligacao.rapido;
    if (canal?.readyState !== 'open') return false;
    // Fila cheia no rápido: descartar é melhor que atrasar; o próximo pacote vem logo
    if (!confiavel && canal.bufferedAmount > FILA_MAXIMA_RAPIDO) return true;
    canal.send(dados);
    return true;
  }

  enviarTexto(peer: string, texto: string): boolean {
    const ligacao = this.ligacoes.get(peer);
    if (ligacao?.caminho !== 'direto' || ligacao.rapido?.readyState !== 'open') return false;
    ligacao.rapido.send(texto);
    return true;
  }

  receptor(peer: string): RTCRtpReceiver | undefined {
    const ligacao = this.ligacoes.get(peer);
    if (ligacao?.caminho !== 'direto' || ligacao.papel !== 'controla') return undefined;
    return ligacao.pc.getReceivers().find((r) => r.track.kind === 'video');
  }

  emissor(peer: string): RTCRtpSender | undefined {
    const ligacao = this.ligacoes.get(peer);
    return ligacao?.caminho === 'direto' ? (ligacao.emissor ?? undefined) : undefined;
  }

  // ---------- Fim ----------

  /**
   * Não deu (prazo, falha, canal fechou): some a conexão, e o SFU segue sozinho. Só vale
   * para a ligação que falhou — se ela já foi trocada por outra, não há nada a fazer.
   */
  private desistir(peer: string, ligacao: Ligacao) {
    if (this.ligacoes.get(peer) !== ligacao) return;
    this.encerrar(peer);
    this.sinalizar(peer, { sessao: ligacao.sessao, tipo: 'fechar' });
  }

  /** Fecha por decisão nossa (controle acabou) e avisa o outro lado */
  fechar(peer: string) {
    const ligacao = this.ligacoes.get(peer);
    if (!ligacao) return;
    this.sinalizar(peer, { sessao: ligacao.sessao, tipo: 'fechar' });
    this.encerrar(peer);
  }

  fecharTodas() {
    Array.from(this.ligacoes.keys()).forEach((peer) => this.fechar(peer));
  }

  private encerrar(peer: string) {
    const ligacao = this.ligacoes.get(peer);
    if (!ligacao) return;
    this.ligacoes.delete(peer);
    window.clearTimeout(ligacao.prazo);
    ligacao.pc.onconnectionstatechange = null;
    ligacao.rapido?.close();
    ligacao.confiavel?.close();
    ligacao.pc.close();
    // A tela volta a vir pelo SFU
    if (ligacao.papel === 'controla') voice.pausarTela(peer, false);
    this.notificar();
  }

  private sinalizar(peer: string, sinal: Sinal) {
    voice.enviarEntrada(peer, codificarSinal(sinal), true, TOPICO_DIRETO);
  }

  private notificar() {
    this.snapshot = Object.fromEntries(
      Array.from(this.ligacoes, ([peer, l]) => [peer, { caminho: l.caminho, video: l.video }])
    );
    this.listeners.forEach((cb) => cb());
  }
}

export const conexaoDireta = new ConexoesDiretas();

/** Por onde está vindo a tela de `peer`; sem ligação, pelo servidor */
export function useConexaoDireta(peer: string): EstadoDireto {
  const snapshot = useSyncExternalStore(conexaoDireta.subscribe, conexaoDireta.getSnapshot);
  return snapshot[peer] ?? SEM_LIGACAO;
}

const SEM_LIGACAO: EstadoDireto = { caminho: 'servidor', video: null };

// Quem pode mexer nesta máquina, e o que fazer com o que chega dela.
//
// A regra é uma só: **nada é aplicado sem estar na lista de permitidos**, e a lista
// começa vazia e só cresce por um clique de quem hospeda. O servidor não participa
// disso — ele nem sabe que existe controle remoto — então nenhum defeito lá consegue
// dar controle a ninguém. O que atravessa a rede já chega filtrado por
// `destinationIdentities`, e aqui é conferido de novo.
import { useSyncExternalStore } from 'react';
import { voice } from './voice';
import {
  MensagemControle,
  PacoteEntrada,
  TIPO,
  TOPICO_CONTROLE,
  TOPICO_ENTRADA,
  codificar,
  codificarControle,
  decodificar,
  decodificarControle,
  ehConfiavel,
} from './entradaProtocolo';
import { CONTROLE_NEUTRO, conectarControle, desconectarControle, atualizarControle } from './controleVirtual';
import { botaoMouse, listarMonitores, moverMouse, rodaMouse, tecla } from './entradaRemota';
import { RUNS_IN_TAURI } from './appWindow';

/**
 * Corta tudo, dos dois lados. É atalho global do sistema porque quem precisa dele está
 * com o jogo em foco, não o DasCord. Quem controla também consegue apertá-lo pela
 * entrada remota — e tudo bem: a única coisa que ele faz é tirar controle.
 */
export const ATALHO_CORTE = 'CommandOrControl+Shift+F12';
export const ATALHO_CORTE_TEXTO = 'Ctrl+Shift+F12';

export interface ControleRemotoSnapshot {
  /** Quem pediu controle desta máquina e ainda não foi respondido */
  pedidos: string[];
  /** Quem está com controle desta máquina agora */
  permitidos: string[];
  /** Monitor desta máquina onde o mouse de quem controla vai cair */
  monitor: string | null;
  /** Para quem estamos mandando entrada, quando somos nós que controlamos */
  controlando: string | null;
  /** Pedimos controle e ainda não houve resposta */
  aguardando: string | null;
}

const VAZIO: ControleRemotoSnapshot = {
  pedidos: [],
  permitidos: [],
  monitor: null,
  controlando: null,
  aguardando: null,
};

class ControleRemotoService {
  private pedidos = new Set<string>();
  private permitidos = new Set<string>();
  private monitor: string | null = null;
  private controlando: string | null = null;
  private aguardando: string | null = null;

  /** O que cada pessoa está segurando agora, para soltar tudo quando o controle acabar */
  private teclasPresas = new Map<string, Set<number>>();
  private botoesPresos = new Map<string, Set<number>>();

  private desinscrever: (() => void) | null = null;
  private desinscreverTela: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private snapshot: ControleRemotoSnapshot = VAZIO;

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): ControleRemotoSnapshot => this.snapshot;

  /** Começa a ouvir o canal de entrada. Ouvir não é permitir: a lista continua vazia. */
  iniciar() {
    if (this.desinscrever) return;
    this.desinscrever = voice.subscribeEntrada((de, dados, topico) => {
      if (topico === TOPICO_CONTROLE) this.receberCombinado(de, dados);
      else if (topico === TOPICO_ENTRADA) this.receberEntrada(de, dados);
    });
    // Parar de transmitir é parar de ser controlado: ninguém mexe às cegas nesta máquina
    this.desinscreverTela = voice.subscribeScreenShare(() => {
      if (!voice.getScreenShareSnapshot().local && this.permitidos.size > 0) this.cortarTudo();
    });
    this.registrarAtalho();
    // Quase sempre o que se transmite é a tela principal: começa por ela, e quem hospeda troca
    listarMonitores()
      .then((monitores) => {
        const principal = monitores.find((m) => m.principal) ?? monitores[0];
        if (!this.monitor && principal) this.definirMonitor(principal.nome);
      })
      .catch(() => {});
  }

  /** Sair do canal de voz encerra tudo: ninguém continua com controle de uma chamada antiga */
  parar() {
    this.desinscrever?.();
    this.desinscrever = null;
    this.desinscreverTela?.();
    this.desinscreverTela = null;
    this.removerAtalho();
    this.encerrar();
    this.cortarTudo();
    this.pedidos.clear();
    this.controlando = null;
    this.aguardando = null;
    this.notificar();
  }

  /**
   * Quem saiu da chamada perde o que tinha: pedido pendente e controle. Sem isso, alguém
   * que caísse e voltasse encontraria o controle ainda liberado.
   */
  sincronizarPresentes(presentes: string[]) {
    const aqui = new Set(presentes);
    let mudou = false;
    this.pedidos.forEach((quem) => {
      if (!aqui.has(quem)) mudou = this.pedidos.delete(quem) || mudou;
    });
    Array.from(this.permitidos).forEach((quem) => {
      if (!aqui.has(quem)) this.revogar(quem);
    });
    if (this.controlando && !aqui.has(this.controlando)) {
      this.controlando = null;
      mudou = true;
    }
    if (this.aguardando && !aqui.has(this.aguardando)) {
      this.aguardando = null;
      mudou = true;
    }
    if (mudou) this.notificar();
  }

  private async registrarAtalho() {
    if (!RUNS_IN_TAURI) return;
    try {
      const { register } = await import('@tauri-apps/plugin-global-shortcut');
      await register(ATALHO_CORTE, (evento) => {
        if (evento.state !== 'Pressed') return;
        this.cortarTudo();
        this.encerrar();
      });
    } catch (e) {
      // Outro programa já pode ter o atalho; o botão na tela continua valendo
      console.warn('Não foi possível registrar o atalho de corte:', e);
    }
  }

  private async removerAtalho() {
    if (!RUNS_IN_TAURI) return;
    try {
      const { unregister } = await import('@tauri-apps/plugin-global-shortcut');
      await unregister(ATALHO_CORTE);
    } catch {
      // Não estava registrado
    }
  }

  // ---------- Lado de quem hospeda ----------

  definirMonitor(nome: string | null) {
    this.monitor = nome;
    this.notificar();
  }

  permitir(quem: string) {
    // Sem tela transmitida, quem controla estaria às cegas; sem monitor, o mouse não tem onde cair
    if (!this.monitor || !voice.getScreenShareSnapshot().local) return;
    this.pedidos.delete(quem);
    this.permitidos.add(quem);
    // Cada pessoa com controle ganha o próprio Xbox virtual nesta máquina
    conectarControle(quem).catch((e: Error) => console.warn('Sem controle virtual para', quem, e.message));
    this.enviarCombinado(quem, { tipo: 'aceito' });
    this.notificar();
  }

  negar(quem: string) {
    this.pedidos.delete(quem);
    this.enviarCombinado(quem, { tipo: 'negado' });
    this.notificar();
  }

  /** Tira o controle de uma pessoa e solta o que ela estava segurando */
  revogar(quem: string) {
    if (!this.permitidos.delete(quem)) return;
    this.soltarTudo(quem);
    desconectarControle(quem).catch(() => {});
    this.enviarCombinado(quem, { tipo: 'encerrado' });
    this.notificar();
  }

  /** O botão de pânico: ninguém mais controla nada, agora */
  cortarTudo() {
    Array.from(this.permitidos).forEach((quem) => this.revogar(quem));
  }

  /**
   * Solta tecla e botão que ficaram pressionados. Sem isso, cortar o controle no meio de
   * um "W" segurado deixa a tecla presa para sempre na máquina de quem hospeda.
   */
  private soltarTudo(quem: string) {
    this.teclasPresas.get(quem)?.forEach((vk) => tecla(vk, false).catch(() => {}));
    this.teclasPresas.delete(quem);
    this.botoesPresos.get(quem)?.forEach((botao) => botaoMouse(botao, false).catch(() => {}));
    this.botoesPresos.delete(quem);
    atualizarControle(quem, CONTROLE_NEUTRO).catch(() => {});
  }

  private receberEntrada(de: string, dados: Uint8Array) {
    // A conferência que importa: quem não está na lista não mexe em nada
    if (!this.permitidos.has(de)) return;
    const pacote = decodificar(dados);
    if (!pacote) return;
    this.aplicar(de, pacote);
  }

  private aplicar(de: string, pacote: PacoteEntrada) {
    switch (pacote.tipo) {
      case TIPO.controle:
        atualizarControle(de, pacote).catch(() => {});
        break;
      case TIPO.mouseMover:
        if (this.monitor) moverMouse(this.monitor, pacote.x, pacote.y).catch(() => {});
        break;
      case TIPO.mouseBotao:
        this.anotar(this.botoesPresos, de, pacote.botao, pacote.pressionado);
        botaoMouse(pacote.botao, pacote.pressionado).catch(() => {});
        break;
      case TIPO.mouseRoda:
        rodaMouse(pacote.horizontal, pacote.vertical).catch(() => {});
        break;
      case TIPO.tecla:
        this.anotar(this.teclasPresas, de, pacote.vk, pacote.pressionado);
        tecla(pacote.vk, pacote.pressionado).catch(() => {});
        break;
    }
  }

  private anotar(onde: Map<string, Set<number>>, quem: string, codigo: number, pressionado: boolean) {
    const presos = onde.get(quem) ?? new Set<number>();
    if (pressionado) presos.add(codigo);
    else presos.delete(codigo);
    onde.set(quem, presos);
  }

  // ---------- Lado de quem controla ----------

  /** Pede controle da máquina de alguém. Quem responde é a pessoa, não o app dela. */
  pedir(dono: string) {
    this.aguardando = dono;
    this.enviarCombinado(dono, { tipo: 'pedido' });
    this.notificar();
  }

  /** Desiste de um pedido que ainda não foi respondido */
  cancelarPedido() {
    if (!this.aguardando) return;
    this.enviarCombinado(this.aguardando, { tipo: 'encerrado' });
    this.aguardando = null;
    this.notificar();
  }

  /** Devolve o controle por vontade própria */
  encerrar() {
    if (!this.controlando) return;
    this.enviarCombinado(this.controlando, { tipo: 'encerrado' });
    this.controlando = null;
    this.notificar();
  }

  enviar(pacote: PacoteEntrada) {
    if (!this.controlando) return;
    voice.enviarEntrada(this.controlando, codificar(pacote), ehConfiavel(pacote));
  }

  // ---------- O combinado ----------

  private enviarCombinado(destino: string, mensagem: MensagemControle) {
    voice.enviarEntrada(destino, codificarControle(mensagem), true, TOPICO_CONTROLE);
  }

  private receberCombinado(de: string, dados: Uint8Array) {
    const mensagem = decodificarControle(dados);
    if (!mensagem) return;

    switch (mensagem.tipo) {
      case 'pedido':
        // Só entra na fila de avisos; quem decide é a pessoa, no clique
        this.pedidos.add(de);
        break;
      case 'aceito':
        if (this.aguardando === de) {
          this.controlando = de;
          this.aguardando = null;
        }
        break;
      case 'negado':
        if (this.aguardando === de) this.aguardando = null;
        break;
      case 'encerrado':
        // Serve para os dois lados: ou perdemos o controle, ou quem controlava (ou só
        // pedia) desistiu
        if (this.controlando === de) this.controlando = null;
        this.pedidos.delete(de);
        if (this.permitidos.has(de)) {
          this.permitidos.delete(de);
          this.soltarTudo(de);
          desconectarControle(de).catch(() => {});
        }
        break;
    }
    this.notificar();
  }

  private notificar() {
    this.snapshot = {
      pedidos: Array.from(this.pedidos),
      permitidos: Array.from(this.permitidos),
      monitor: this.monitor,
      controlando: this.controlando,
      aguardando: this.aguardando,
    };
    this.listeners.forEach((cb) => cb());
  }
}

export const controleRemoto = new ControleRemotoService();

export function useControleRemoto(): ControleRemotoSnapshot {
  return useSyncExternalStore(controleRemoto.subscribe, controleRemoto.getSnapshot);
}

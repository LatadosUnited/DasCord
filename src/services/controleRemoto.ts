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
  TOPICO_DIRETO,
  TOPICO_ENTRADA,
  codificar,
  codificarControle,
  decodificar,
  decodificarControle,
  ehConfiavel,
} from './entradaProtocolo';
import {
  CONTROLE_NEUTRO,
  EstadoControle,
  atualizarControle,
  conectarControle,
  desconectarControle,
} from './controleVirtual';
import { botaoMouse, listarMonitores, moverMouse, rodaMouse, tecla } from './entradaRemota';
import { RUNS_IN_TAURI } from './appWindow';
import { registrarPong, responderPing } from './latencia';
import { conexaoDireta } from './conexaoDireta';

/**
 * Corta tudo, dos dois lados. É atalho global do sistema porque quem precisa dele está
 * com o jogo em foco, não o DasCord. Quem controla também consegue apertá-lo pela
 * entrada remota — e tudo bem: a única coisa que ele faz é tirar controle.
 */
export const ATALHO_CORTE = 'CommandOrControl+Shift+F12';
export const ATALHO_CORTE_TEXTO = 'Ctrl+Shift+F12';

/**
 * Mouse e teclado de quem controla, na ordem em que chegaram, um comando de cada vez.
 * Cada comando é uma chamada ao Rust; sem fila, um clique podia ser aplicado antes do
 * movimento que veio antes dele e cair no lugar errado. Movimento que ainda não saiu é
 * trocado pelo mais novo — fila de movimento velho é só atraso —, mas clique e tecla
 * nunca furam a fila.
 */
class FilaEntrada {
  private fila: { movimento: boolean; executar: () => Promise<unknown> }[] = [];
  private ocupada = false;

  mover(executar: () => Promise<unknown>) {
    const ultimo = this.fila[this.fila.length - 1];
    if (ultimo?.movimento) ultimo.executar = executar;
    else this.fila.push({ movimento: true, executar });
    this.andar();
  }

  outro(executar: () => Promise<unknown>) {
    this.fila.push({ movimento: false, executar });
    this.andar();
  }

  private andar() {
    if (this.ocupada) return;
    const item = this.fila.shift();
    if (!item) return;
    this.ocupada = true;
    item
      .executar()
      .catch(() => {})
      .finally(() => {
        this.ocupada = false;
        this.andar();
      });
  }
}

/**
 * Para o controle de cada pessoa: enquanto uma atualização não volta do Rust, só a mais
 * nova que chegar importa. Estado de controle é sempre o estado inteiro, então pular os
 * do meio não perde nada.
 */
function ultimoVence(executar: (estado: EstadoControle) => Promise<unknown>) {
  let ocupado = false;
  let proximo: EstadoControle | null = null;
  const rodar = (estado: EstadoControle) => {
    ocupado = true;
    executar(estado)
      .catch(() => {})
      .finally(() => {
        ocupado = false;
        if (proximo) {
          const seguinte = proximo;
          proximo = null;
          rodar(seguinte);
        }
      });
  };
  return (estado: EstadoControle) => {
    if (ocupado) proximo = estado;
    else rodar(estado);
  };
}

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
  /** A tela de quem controlamos ocupa o monitor inteiro */
  telaCheia: boolean;
}

const VAZIO: ControleRemotoSnapshot = {
  pedidos: [],
  permitidos: [],
  monitor: null,
  controlando: null,
  aguardando: null,
  telaCheia: false,
};

class ControleRemotoService {
  private pedidos = new Set<string>();
  private permitidos = new Set<string>();
  private monitor: string | null = null;
  private controlando: string | null = null;
  private aguardando: string | null = null;
  private telaCheia = false;

  private filaEntrada = new FilaEntrada();
  private controles = new Map<string, (estado: EstadoControle) => void>();

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
      else if (topico === TOPICO_DIRETO) conexaoDireta.receberSinal(de, dados);
    });
    conexaoDireta.configurar({
      // Oferta de conexão direta só vale de quem acabou de nos dar controle
      aceitarOferta: (de) => this.controlando === de,
      // Pela conexão direta chega o mesmo que pelo SFU, e passa pelo mesmo porteiro
      aoReceber: (de, dados) => {
        if (typeof dados === 'string') this.receberCombinado(de, new TextEncoder().encode(dados));
        else this.receberEntrada(de, dados);
      },
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
    conexaoDireta.fecharTodas();
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
      conexaoDireta.fechar(this.controlando);
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

  /** Quem controla sai e volta da tela cheia sem largar o controle */
  definirTelaCheia(ativa: boolean) {
    if (!this.controlando) return;
    this.telaCheia = ativa;
    this.notificar();
  }

  private controleDe(quem: string) {
    let atualizar = this.controles.get(quem);
    if (!atualizar) {
      atualizar = ultimoVence((estado) => atualizarControle(quem, estado));
      this.controles.set(quem, atualizar);
    }
    return atualizar;
  }

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
    // O "aceito" vai antes: quem pediu só aceita a oferta direta depois de saber que tem controle
    const tela = voice.getScreenShareSnapshot().local?.getVideoTracks()[0];
    if (tela) conexaoDireta.abrir(quem, tela);
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
    conexaoDireta.fechar(quem);
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
    // Pela mesma fila: um "soltou" que furasse a fila podia ser desfeito por um "apertou"
    // que já estava nela
    this.teclasPresas.get(quem)?.forEach((vk) => this.filaEntrada.outro(() => tecla(vk, false)));
    this.teclasPresas.delete(quem);
    this.botoesPresos.get(quem)?.forEach((botao) => this.filaEntrada.outro(() => botaoMouse(botao, false)));
    this.botoesPresos.delete(quem);
    this.controleDe(quem)(CONTROLE_NEUTRO);
    this.controles.delete(quem);
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
        this.controleDe(de)(pacote);
        break;
      case TIPO.mouseMover: {
        const monitor = this.monitor;
        if (monitor) this.filaEntrada.mover(() => moverMouse(monitor, pacote.x, pacote.y));
        break;
      }
      case TIPO.mouseBotao:
        this.anotar(this.botoesPresos, de, pacote.botao, pacote.pressionado);
        this.filaEntrada.outro(() => botaoMouse(pacote.botao, pacote.pressionado));
        break;
      case TIPO.mouseRoda:
        this.filaEntrada.outro(() => rodaMouse(pacote.horizontal, pacote.vertical));
        break;
      case TIPO.tecla:
        this.anotar(this.teclasPresas, de, pacote.vk, pacote.pressionado);
        this.filaEntrada.outro(() => tecla(pacote.vk, pacote.pressionado));
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
    conexaoDireta.fechar(this.controlando);
    this.controlando = null;
    this.notificar();
  }

  /** Pelo caminho direto quando ele está de pé; senão, pelo SFU */
  enviar(pacote: PacoteEntrada) {
    if (!this.controlando) return;
    const dados = codificar(pacote);
    const confiavel = ehConfiavel(pacote);
    if (conexaoDireta.enviar(this.controlando, dados, confiavel)) return;
    voice.enviarEntrada(this.controlando, dados, confiavel);
  }

  // ---------- O combinado ----------

  private enviarCombinado(destino: string, mensagem: MensagemControle) {
    voice.enviarEntrada(destino, codificarControle(mensagem), true, TOPICO_CONTROLE);
  }

  private receberCombinado(de: string, dados: Uint8Array) {
    const mensagem = decodificarControle(dados);
    if (!mensagem) return;

    // A medição de atraso passa por aqui toda hora; não mexe em estado nem redesenha nada
    if (mensagem.tipo === 'ping') return responderPing(de, mensagem.t);
    if (mensagem.tipo === 'pong') return registrarPong(de, mensagem.t, mensagem.codificacao);

    switch (mensagem.tipo) {
      case 'pedido':
        // Só entra na fila de avisos; quem decide é a pessoa, no clique
        this.pedidos.add(de);
        break;
      case 'aceito':
        if (this.aguardando === de) {
          this.controlando = de;
          this.aguardando = null;
          // Ganhou o controle, ganhou a tela inteira: é assim que se joga
          this.telaCheia = true;
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
        conexaoDireta.fechar(de);
        break;
    }
    this.notificar();
  }

  private notificar() {
    // Sem controle não há tela cheia, venha o fim de onde vier
    if (!this.controlando) this.telaCheia = false;
    this.snapshot = {
      pedidos: Array.from(this.pedidos),
      permitidos: Array.from(this.permitidos),
      monitor: this.monitor,
      controlando: this.controlando,
      aguardando: this.aguardando,
      telaCheia: this.telaCheia,
    };
    this.listeners.forEach((cb) => cb());
  }
}

export const controleRemoto = new ControleRemotoService();

export function useControleRemoto(): ControleRemotoSnapshot {
  return useSyncExternalStore(controleRemoto.subscribe, controleRemoto.getSnapshot);
}

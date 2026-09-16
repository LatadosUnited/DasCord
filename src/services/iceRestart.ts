// Quando uma conexão de voz cai (troca de rede, VPN, Wi-Fi ruim), o ICE é
// reiniciado em vez de deixar a pessoa muda para sempre. A política de quando
// tentar, quanto esperar e quando desistir vive aqui.
import { PeerConnectionStatus } from '../types';

/** "disconnected" costuma voltar sozinho (troca de rede rápida); só reinicia o ICE depois disso */
const DISCONNECT_GRACE_MS = 4000;
/** O lado educado espera mais, para os dois não reiniciarem ao mesmo tempo */
const POLITE_EXTRA_DELAY_MS = 2500;
const RETRY_MS = 10000;
const MAX_ATTEMPTS = 5;

interface Options {
  /** Em ofertas cruzadas, este lado é o que cede — e também o que espera mais para reiniciar */
  polite: boolean;
  /** Se esta conexão ainda é a atual deste participante; uma substituída para de tentar */
  isCurrent: () => boolean;
  onState: (state: PeerConnectionStatus) => void;
}

/**
 * Acompanha uma conexão e a traz de volta quando ela cai.
 * Um por participante, criado junto com o `RTCPeerConnection`.
 */
export class IceRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;

  constructor(private pc: RTCPeerConnection, private peerId: string, private options: Options) {}

  /** Chamado a cada mudança de `connectionState` */
  handleConnectionState() {
    if (!this.options.isCurrent()) return;

    switch (this.pc.connectionState) {
      case 'connected':
        this.attempts = 0;
        this.cancel();
        this.options.onState('connected');
        break;
      case 'disconnected':
      case 'failed': {
        const failed = this.pc.connectionState === 'failed';
        if (this.attempts >= MAX_ATTEMPTS) {
          this.options.onState('failed');
          break;
        }
        this.options.onState('reconnecting');
        const delay =
          (failed ? 0 : DISCONNECT_GRACE_MS) + (this.options.polite ? POLITE_EXTRA_DELAY_MS : 0);
        this.schedule(delay);
        break;
      }
    }
  }

  /** Para de tentar: a conexão foi fechada ou substituída */
  cancel() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.options.isCurrent()) return;
      const state = this.pc.connectionState;
      if (state !== 'disconnected' && state !== 'failed') return;

      if (this.attempts >= MAX_ATTEMPTS) {
        console.warn(`Conexão de voz com ${this.peerId} não voltou após ${MAX_ATTEMPTS} tentativas.`);
        this.options.onState('failed');
        return;
      }
      this.attempts++;
      // Gera uma nova oferta com credenciais ICE novas (onnegotiationneeded)
      this.pc.restartIce();
      // Se continuar sem conexão, o estado pode não mudar mais: confere de novo depois
      this.schedule(RETRY_MS);
    }, delayMs);
  }
}

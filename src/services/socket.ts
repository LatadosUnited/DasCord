// WebSocket Client Service for DasCord Real-time Rust Server
import { WS_URL } from './config';

export interface SocketEvent {
  type:
    | 'message'
    | 'reaction'
    | 'typing'
    | 'friend-request-received'
    | 'friend-request-accepted'
    | 'voice-join'
    | 'voice-leave'
    | 'voice-speaking'
    | 'voice-offer'
    | 'voice-answer'
    | 'voice-candidate'
    | 'voice-announce'
    | 'auth-ok'
    | 'auth-error';
  channelId: string;
  data: any;
}

type MessageCallback = (event: SocketEvent) => void;
type StatusCallback = (connected: boolean) => void;
type AuthErrorCallback = () => void;

class RealtimeSocket {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private messageListeners: Set<MessageCallback> = new Set();
  private statusListeners: Set<StatusCallback> = new Set();
  private authErrorListeners: Set<AuthErrorCallback> = new Set();
  // Só fica true depois que o servidor confirma o token (auth-ok)
  private isConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Define o token da sessão e (re)conecta. Passe null no logout para desconectar. */
  setToken(token: string | null) {
    if (token === this.token && this.ws) return;
    this.token = token;
    this.closeSocket();
    if (token) {
      this.connect();
    }
  }

  private connect() {
    if (!this.token) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    try {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws || !this.token) return;
        // A primeira mensagem precisa ser a autenticação
        ws.send(JSON.stringify({ type: 'auth', token: this.token }));
      };

      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        let parsed: SocketEvent;
        try {
          parsed = JSON.parse(event.data);
        } catch (err) {
          console.error('[DasCord] Erro ao processar mensagem do socket:', err);
          return;
        }

        if (parsed.type === 'auth-ok') {
          this.setConnected(true);
          console.log('🟢 [DasCord] Conectado e autenticado no servidor WebSocket Rust!');
          return;
        }
        if (parsed.type === 'auth-error') {
          // Token rejeitado: não adianta reconectar com ele
          this.token = null;
          this.authErrorListeners.forEach((cb) => cb());
          return;
        }
        this.messageListeners.forEach((cb) => cb(parsed));
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.setConnected(false);
        this.scheduleReconnect();
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        ws.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private closeSocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null; // desarma os handlers antes de fechar
      ws.close();
    }
    this.setConnected(false);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.token) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  send(event: SocketEvent) {
    if (this.ws && this.isConnected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
      return true;
    }
    return false;
  }

  subscribeMessages(cb: MessageCallback) {
    this.messageListeners.add(cb);
    return () => {
      this.messageListeners.delete(cb);
    };
  }

  subscribeStatus(cb: StatusCallback) {
    this.statusListeners.add(cb);
    cb(this.isConnected);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  subscribeAuthError(cb: AuthErrorCallback) {
    this.authErrorListeners.add(cb);
    return () => {
      this.authErrorListeners.delete(cb);
    };
  }

  private setConnected(connected: boolean) {
    if (this.isConnected === connected) return;
    this.isConnected = connected;
    this.statusListeners.forEach((cb) => cb(connected));
  }
}

export const realtimeSocket = new RealtimeSocket();

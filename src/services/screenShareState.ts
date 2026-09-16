// O que está sendo transmitido agora: a nossa tela, quem pediu para vê-la e as
// telas que escolhemos assistir. Guarda o estado e avisa a interface; quem envia
// o vídeo (malha P2P ou SFU) fica de fora.
import { EMPTY_SCREEN_SNAPSHOT, ScreenShareSnapshot } from './voiceTypes';

export class ScreenShareState {
  private localStream: MediaStream | null = null;
  /** Quem pediu para assistir à nossa tela. O SFU não informa isso, e fica vazio. */
  private watchers: Set<string> = new Set();
  private watchingIds: Set<string> = new Set();
  private remoteStreams: Map<string, MediaStream> = new Map();
  private snapshot: ScreenShareSnapshot = EMPTY_SCREEN_SNAPSHOT;
  private listeners: Set<() => void> = new Set();

  // Campos para irem direto ao `useSyncExternalStore`
  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): ScreenShareSnapshot => this.snapshot;

  // ---------- A nossa tela ----------

  get local(): MediaStream | null {
    return this.localStream;
  }

  get sharing(): boolean {
    return this.localStream !== null;
  }

  setLocal(stream: MediaStream | null) {
    this.localStream = stream;
  }

  // ---------- Quem assiste à nossa ----------

  watcherIds(): string[] {
    return Array.from(this.watchers);
  }

  addWatcher(id: string) {
    this.watchers.add(id);
  }

  /** Devolve se a pessoa estava mesmo assistindo */
  removeWatcher(id: string): boolean {
    return this.watchers.delete(id);
  }

  clearWatchers() {
    this.watchers.clear();
  }

  // ---------- As telas que assistimos ----------

  isWatching(id: string): boolean {
    return this.watchingIds.has(id);
  }

  startWatching(id: string) {
    this.watchingIds.add(id);
  }

  setRemote(id: string, stream: MediaStream) {
    this.remoteStreams.set(id, stream);
  }

  /** Para de assistir e esquece o vídeo recebido */
  forget(id: string) {
    this.watchingIds.delete(id);
    this.remoteStreams.delete(id);
  }

  /** O vídeo sumiu, mas continuamos querendo assistir (o outro lado voltou a enviar depois) */
  dropRemote(id: string): boolean {
    return this.remoteStreams.delete(id);
  }

  /** Esquece tudo desta pessoa: a tela dela e o pedido dela pela nossa */
  removePeer(id: string) {
    this.watchers.delete(id);
    this.forget(id);
  }

  clear() {
    this.localStream = null;
    this.watchers.clear();
    this.watchingIds.clear();
    this.remoteStreams.clear();
  }

  notify() {
    this.snapshot = {
      local: this.localStream,
      viewerCount: this.watchers.size,
      watching: Array.from(this.watchingIds),
      remote: Object.fromEntries(this.remoteStreams),
    };
    this.listeners.forEach((cb) => cb());
  }
}

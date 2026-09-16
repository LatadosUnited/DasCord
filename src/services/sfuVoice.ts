// Voz pelo servidor de mídia (SFU): cada pessoa envia o áudio uma vez para o LiveKit,
// que repassa aos outros. Espelha a interface de webrtc.ts (veja VoiceEngine em voice.ts).
import {
  ConnectionState,
  LocalTrackPublication,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';
import { realtimeSocket, SocketEvent } from './socket';
import {
  applyOutputDevice,
  audioInputOptions,
  getVoiceSettings,
  screenQualityPreset,
  subscribeVoiceSettings,
} from './voiceSettings';
import type { User, VoiceParticipant } from '../types';
import * as signal from './voiceSignaling';
import { InputStatusStore } from './microphone';
import type { ParticipantsListener, ScreenShareSnapshot } from './voiceTypes';
import type { VoiceCredentials } from './voice';

const EMPTY_SCREEN_SNAPSHOT: ScreenShareSnapshot = { local: null, viewerCount: 0, watching: [], remote: {} };

/** Avatar vai no metadata do token, gerado pelo servidor Rust */
function avatarOf(participant: Participant): string {
  try {
    return participant.metadata ? JSON.parse(participant.metadata).avatar ?? '' : '';
  } catch {
    return '';
  }
}

class SfuVoiceService {
  private room: Room | null = null;
  private currentUser: User | null = null;
  private currentChannelId: string | null = null;
  private isMuted = false;
  private isDeafened = false;
  private isSpeaking = false;

  private participants: Map<string, VoiceParticipant> = new Map();
  private participantsListeners: Set<ParticipantsListener> = new Set();
  /** O LiveKit não transmite "ensurdecido"; isso chega pelo nosso WebSocket */
  private remoteDeafened: Map<string, boolean> = new Map();
  private audioElements: Map<string, HTMLMediaElement> = new Map();
  private socketUnsub: (() => void) | null = null;
  private statusUnsub: (() => void) | null = null;
  private settingsUnsub: (() => void) | null = null;
  private joinGeneration = 0;

  // Transmissão de tela
  private localScreen: MediaStream | null = null;
  private watching: Set<string> = new Set();
  private remoteScreens: Map<string, MediaStream> = new Map();
  private screenSnapshot: ScreenShareSnapshot = EMPTY_SCREEN_SNAPSHOT;
  private screenListeners: Set<() => void> = new Set();

  private input = new InputStatusStore();

  async join(
    channelId: string,
    user: User,
    onParticipantsUpdate: ParticipantsListener,
    credentials: VoiceCredentials
  ) {
    this.leave();
    const generation = ++this.joinGeneration;

    this.currentChannelId = channelId;
    this.currentUser = user;
    this.participantsListeners.clear();
    this.participantsListeners.add(onParticipantsUpdate);

    const settings = getVoiceSettings();
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: audioInputOptions(settings.inputDeviceId),
    });
    this.room = room;
    this.bindEvents(room, generation);

    try {
      await room.connect(credentials.url, credentials.token);
    } catch (err) {
      console.warn('Não foi possível entrar no servidor de voz:', err);
      this.leave();
      return;
    }
    // Saiu do canal enquanto a conexão era feita
    if (generation !== this.joinGeneration) {
      room.disconnect();
      return;
    }

    await this.publishMicrophone();
    this.syncParticipants();

    // A lista do canal (para quem não está na chamada) continua vindo do servidor Rust
    this.sendJoin();
    let initialStatus = true;
    this.statusUnsub = realtimeSocket.subscribeStatus((connected) => {
      if (initialStatus) {
        initialStatus = false;
        return;
      }
      if (connected && generation === this.joinGeneration) this.sendJoin();
    });
    this.socketUnsub = realtimeSocket.subscribeMessages((event) => this.handleSocketEvent(event));
    this.settingsUnsub = subscribeVoiceSettings(() => this.handleSettingsChange());
  }

  leave() {
    this.joinGeneration++;

    if (this.currentChannelId && this.currentUser) {
      signal.sendLeave(this.currentChannelId, this.currentUser.id);
    }

    this.audioElements.forEach((el) => el.remove());
    this.audioElements.clear();
    this.room?.disconnect();
    this.room = null;

    this.socketUnsub?.();
    this.socketUnsub = null;
    this.statusUnsub?.();
    this.statusUnsub = null;
    this.settingsUnsub?.();
    this.settingsUnsub = null;

    this.participants.clear();
    this.remoteDeafened.clear();
    this.localScreen = null;
    this.watching.clear();
    this.remoteScreens.clear();
    this.isSpeaking = false;
    this.input.set('ok');
    this.notifyParticipants();
    this.notifyScreen();
    this.participantsListeners.clear();
    this.currentChannelId = null;
    this.currentUser = null;
  }

  // ---------- Microfone ----------

  private async publishMicrophone(): Promise<boolean> {
    if (!this.room) return false;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(
        true,
        audioInputOptions(getVoiceSettings().inputDeviceId)
      );
    } catch (err) {
      // Sem microfone ou sem permissão: entra só ouvindo
      console.warn('Não foi possível publicar o microfone:', err);
      this.input.set('unavailable');
      return false;
    }
    if (this.isMuted) await this.microphonePublication()?.mute();
    this.input.set('ok');
    this.syncParticipants();
    return true;
  }

  private microphonePublication(): LocalTrackPublication | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
  }

  async retryMicrophone(): Promise<boolean> {
    if (!this.room || this.microphonePublication()) return !!this.microphonePublication();
    return this.publishMicrophone();
  }

  setMuted(muted: boolean) {
    this.isMuted = muted;
    const publication = this.microphonePublication();
    if (publication) {
      const change = muted ? publication.mute() : publication.unmute();
      change.catch((err) => console.warn('Não foi possível mudar o microfone:', err));
    } else if (!muted && this.room) {
      // Desmutar sem microfone publicado: tenta abrir de novo
      this.publishMicrophone();
    }
    if (this.room) {
      this.syncParticipants();
      this.broadcastVoiceState();
    }
  }

  setDeafened(deafened: boolean) {
    this.isDeafened = deafened;
    this.audioElements.forEach((el) => {
      el.muted = deafened;
    });
    if (this.room) {
      this.syncParticipants();
      this.broadcastVoiceState();
    }
  }

  private handleSettingsChange() {
    if (!this.room) return;
    const { inputDeviceId, outputDeviceId } = getVoiceSettings();
    this.room.switchActiveDevice('audioinput', inputDeviceId).catch((err) => {
      console.warn('Não foi possível trocar o microfone:', err);
    });
    this.audioElements.forEach((el) => applyOutputDevice(el as HTMLAudioElement, outputDeviceId));
  }

  // ---------- Transmissão de tela ----------

  async startScreenShare(): Promise<string | null> {
    if (!this.room || this.localScreen) return null;
    const preset = screenQualityPreset(getVoiceSettings().screenQuality);

    let publication: LocalTrackPublication | undefined;
    try {
      publication = await this.room.localParticipant.setScreenShareEnabled(
        true,
        {
          resolution: { width: preset.width, height: preset.height, frameRate: preset.frameRate },
          contentHint: preset.contentHint,
          audio: false,
        },
        { screenShareEncoding: { maxBitrate: preset.maxBitrate, maxFramerate: preset.frameRate } }
      );
    } catch (err) {
      // Fechar o seletor sem escolher nada não é erro
      if (err instanceof DOMException && err.name === 'NotAllowedError') return null;
      console.warn('Não foi possível capturar a tela:', err);
      return 'Não foi possível capturar a tela.';
    }

    const track = publication?.track;
    if (!track) return null;
    this.localScreen = track.mediaStream ?? new MediaStream([track.mediaStreamTrack]);
    // Botão "Parar de compartilhar" do próprio sistema
    track.mediaStreamTrack.addEventListener('ended', () => this.stopScreenShare());

    this.sendScreenEvent('screen-start');
    this.syncParticipants();
    this.notifyScreen();
    return null;
  }

  stopScreenShare() {
    if (!this.room || !this.localScreen) return;
    this.room.localParticipant.setScreenShareEnabled(false).catch((err) => {
      console.warn('Não foi possível parar a transmissão:', err);
    });
    this.localScreen = null;
    this.sendScreenEvent('screen-stop');
    this.syncParticipants();
    this.notifyScreen();
  }

  /** No SFU, assistir é se inscrever na faixa de vídeo de quem transmite */
  watchScreen(peerId: string) {
    if (this.watching.has(peerId)) return;
    const publication = this.screenPublication(peerId);
    if (!publication) return;

    this.watching.add(peerId);
    publication.setSubscribed(true);
    this.notifyScreen();
  }

  stopWatchingScreen(peerId: string) {
    if (!this.watching.delete(peerId)) return;
    this.screenPublication(peerId)?.setSubscribed(false);
    this.remoteScreens.delete(peerId);
    this.notifyScreen();
  }

  private screenPublication(identity: string): RemoteTrackPublication | undefined {
    return this.room?.remoteParticipants.get(identity)?.getTrackPublication(Track.Source.ScreenShare);
  }

  subscribeScreenShare = (cb: () => void) => {
    this.screenListeners.add(cb);
    return () => {
      this.screenListeners.delete(cb);
    };
  };

  getScreenShareSnapshot = (): ScreenShareSnapshot => this.screenSnapshot;

  // ---------- Eventos da sala ----------

  private bindEvents(room: Room, generation: number) {
    const alive = () => generation === this.joinGeneration;

    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!alive()) return;
        if (track.kind === Track.Kind.Audio) {
          this.attachAudio(participant.identity, track);
        } else if (publication.source === Track.Source.ScreenShare) {
          if (!this.watching.has(participant.identity)) {
            // Ninguém pediu para assistir: não gasta banda com o vídeo
            publication.setSubscribed(false);
            return;
          }
          this.remoteScreens.set(participant.identity, track.mediaStream ?? new MediaStream([track.mediaStreamTrack]));
          this.notifyScreen();
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        track.detach().forEach((el) => el.remove());
        this.audioElements.delete(participant.identity);
        if (this.remoteScreens.delete(participant.identity)) this.notifyScreen();
      })
      .on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        // Telas só são baixadas sob pedido
        if (publication.source === Track.Source.ScreenShare && !this.watching.has(participant.identity)) {
          publication.setSubscribed(false);
        }
        this.syncParticipants();
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => this.handleSpeakers(speakers))
      .on(RoomEvent.ParticipantConnected, () => this.syncParticipants())
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        this.remoteDeafened.delete(participant.identity);
        this.watching.delete(participant.identity);
        this.remoteScreens.delete(participant.identity);
        this.audioElements.get(participant.identity)?.remove();
        this.audioElements.delete(participant.identity);
        this.syncParticipants();
        this.notifyScreen();
      })
      .on(RoomEvent.TrackMuted, () => this.syncParticipants())
      .on(RoomEvent.TrackUnmuted, () => this.syncParticipants())
      .on(RoomEvent.TrackUnpublished, () => this.syncParticipants())
      .on(RoomEvent.LocalTrackPublished, () => this.syncParticipants())
      .on(RoomEvent.LocalTrackUnpublished, () => this.syncParticipants())
      .on(RoomEvent.ParticipantMetadataChanged, () => this.syncParticipants())
      .on(RoomEvent.ParticipantNameChanged, () => this.syncParticipants())
      .on(RoomEvent.ConnectionStateChanged, () => this.syncParticipants());
  }

  private attachAudio(identity: string, track: RemoteTrack) {
    const element = track.attach();
    element.muted = this.isDeafened;
    applyOutputDevice(element as HTMLAudioElement, getVoiceSettings().outputDeviceId);
    document.body.appendChild(element);
    this.audioElements.get(identity)?.remove();
    this.audioElements.set(identity, element);
  }

  private handleSpeakers(speakers: Participant[]) {
    const speaking = new Set(speakers.map((s) => s.identity));
    this.participants.forEach((participant, id) => {
      participant.speaking = speaking.has(id);
    });
    this.notifyParticipants();

    // Quem está fora da chamada vê o indicador pela lista do canal
    const me = this.currentUser?.id;
    const meSpeaking = !!me && speaking.has(me);
    if (meSpeaking !== this.isSpeaking) {
      this.isSpeaking = meSpeaking;
      this.broadcastSpeaking(meSpeaking);
    }
  }

  /** Reconstrói a lista a partir do estado da sala: é a fonte da verdade */
  private syncParticipants() {
    const room = this.room;
    const user = this.currentUser;
    if (!room || !user) return;

    const reconnecting = room.state !== ConnectionState.Connected;
    const next: Map<string, VoiceParticipant> = new Map();

    next.set(user.id, {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      speaking: this.participants.get(user.id)?.speaking ?? false,
      muted: this.isMuted,
      deafened: this.isDeafened,
      streaming: this.localScreen !== null,
    });

    room.remoteParticipants.forEach((participant) => {
      const microphone = participant.getTrackPublication(Track.Source.Microphone);
      next.set(participant.identity, {
        id: participant.identity,
        name: participant.name || participant.identity,
        avatar: avatarOf(participant),
        speaking: this.participants.get(participant.identity)?.speaking ?? false,
        // Sem microfone publicado, a pessoa está ouvindo apenas
        muted: microphone?.isMuted ?? true,
        deafened: this.remoteDeafened.get(participant.identity) ?? false,
        streaming: !!participant.getTrackPublication(Track.Source.ScreenShare),
        connection: reconnecting ? 'reconnecting' : 'connected',
      });
    });

    this.participants = next;
    this.notifyParticipants();
  }

  // ---------- Avisos pelo WebSocket do servidor Rust ----------

  private handleSocketEvent(event: SocketEvent) {
    if (event.channelId !== this.currentChannelId || event.type !== 'voice-state') return;
    const { userId, deafened } = event.data ?? {};
    if (!userId || userId === this.currentUser?.id) return;

    this.remoteDeafened.set(userId, !!deafened);
    const participant = this.participants.get(userId);
    if (participant) {
      participant.deafened = !!deafened;
      this.notifyParticipants();
    }
  }

  private sendJoin() {
    if (!this.currentChannelId || !this.currentUser) return;
    signal.sendJoin(this.currentChannelId, this.currentUser, {
      muted: this.isMuted,
      deafened: this.isDeafened,
      streaming: this.localScreen !== null,
    });
  }

  private broadcastVoiceState() {
    if (!this.currentChannelId) return;
    signal.sendVoiceState(this.currentChannelId, this.isMuted, this.isDeafened);
  }

  private broadcastSpeaking(speaking: boolean) {
    if (!this.currentChannelId || !this.currentUser) return;
    signal.sendSpeaking(this.currentChannelId, this.currentUser.id, speaking);
  }

  private sendScreenEvent(type: 'screen-start' | 'screen-stop') {
    if (!this.currentChannelId || !this.currentUser) return;
    if (type === 'screen-start') signal.sendScreenStart(this.currentChannelId, this.currentUser.id);
    else signal.sendScreenStop(this.currentChannelId, this.currentUser.id);
  }

  // ---------- Estado observável ----------

  subscribeInputStatus = this.input.subscribe;

  getInputStatus = this.input.get;

  private notifyParticipants() {
    const list = Array.from(this.participants.values(), (p) => ({ ...p }));
    this.participantsListeners.forEach((cb) => cb(list));
  }

  private notifyScreen() {
    this.screenSnapshot = {
      local: this.localScreen,
      // O SFU não informa quantas pessoas estão assistindo
      viewerCount: 0,
      watching: Array.from(this.watching),
      remote: Object.fromEntries(this.remoteScreens),
    };
    this.screenListeners.forEach((cb) => cb());
  }
}

export const sfuVoice = new SfuVoiceService();

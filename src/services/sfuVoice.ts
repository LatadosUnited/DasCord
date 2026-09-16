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
  ANALYSER_FFT_SIZE,
  applyOutputDevice,
  audioInputOptions,
  createLevelMeter,
  createSpeechGate,
  getVoiceSettings,
  LevelMeter,
  screenQualityPreset,
  SpeechGate,
  subscribeVoiceSettings,
} from './voiceSettings';
import type { User, VoiceParticipant } from '../types';
import type { InputStatus, ScreenShareSnapshot } from './webrtc';
import type { VoiceCredentials } from './voice';

type ParticipantsListener = (participants: VoiceParticipant[]) => void;

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

  // Detecção de fala: o limiar de Configurações > Voz e Áudio vale aqui também
  private audioContext: AudioContext | null = null;
  private levelMeter: LevelMeter | null = null;
  private speechGate: SpeechGate | null = null;
  private vadInterval: any = null;
  /** Quem já anunciou a própria fala pelo WebSocket; para esses, o limiar deles é que manda */
  private speakingFromPeers: Set<string> = new Set();

  // Só reage à troca de dispositivo, não a cada arrastada do controle de sensibilidade
  private appliedInputDeviceId = getVoiceSettings().inputDeviceId;
  private appliedOutputDeviceId = getVoiceSettings().outputDeviceId;

  // Transmissão de tela
  private localScreen: MediaStream | null = null;
  private watching: Set<string> = new Set();
  private remoteScreens: Map<string, MediaStream> = new Map();
  private screenSnapshot: ScreenShareSnapshot = EMPTY_SCREEN_SNAPSHOT;
  private screenListeners: Set<() => void> = new Set();

  private inputStatus: InputStatus = 'ok';
  private inputListeners: Set<() => void> = new Set();

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
    this.appliedInputDeviceId = settings.inputDeviceId;
    this.appliedOutputDeviceId = settings.outputDeviceId;
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
      realtimeSocket.send({
        type: 'voice-leave',
        channelId: this.currentChannelId,
        data: { userId: this.currentUser.id },
      });
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

    this.teardownVAD();
    this.speakingFromPeers.clear();
    this.participants.clear();
    this.remoteDeafened.clear();
    this.localScreen = null;
    this.watching.clear();
    this.remoteScreens.clear();
    this.isSpeaking = false;
    this.setInputStatus('ok');
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
      this.setInputStatus('unavailable');
      return false;
    }
    if (this.isMuted) await this.microphonePublication()?.mute();
    this.setInputStatus('ok');
    this.setupVAD();
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
    if (muted) this.setLocalSpeaking(false);
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

    // O limiar de fala é lido a cada medição, então mudá-lo não precisa mexer em nada aqui
    if (inputDeviceId !== this.appliedInputDeviceId) {
      this.appliedInputDeviceId = inputDeviceId;
      this.room
        .switchActiveDevice('audioinput', inputDeviceId)
        // O microfone virou outro: a medição precisa acompanhar
        .then(() => this.setupVAD())
        .catch((err) => console.warn('Não foi possível trocar o microfone:', err));
    }

    if (outputDeviceId !== this.appliedOutputDeviceId) {
      this.appliedOutputDeviceId = outputDeviceId;
      this.audioElements.forEach((el) => applyOutputDevice(el as HTMLAudioElement, outputDeviceId));
    }
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
        this.speakingFromPeers.delete(participant.identity);
        this.syncParticipants();
        this.notifyScreen();
      })
      .on(RoomEvent.TrackMuted, () => this.syncParticipants())
      .on(RoomEvent.TrackUnmuted, () => this.syncParticipants())
      .on(RoomEvent.TrackUnpublished, () => this.syncParticipants())
      .on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication) => {
        // Rede de segurança: se a faixa só ficou pronta depois do publish, mede agora
        if (publication.source === Track.Source.Microphone && !this.vadInterval) this.setupVAD();
        this.syncParticipants();
      })
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

  // ---------- Detecção de fala ----------

  /**
   * Mede o microfone já publicado para aplicar a sensibilidade escolhida nas
   * Configurações. O LiveKit tem detecção própria (`activeSpeakers`), mas com o
   * limiar dele: sem isto, o controle de sensibilidade não valeria nada no SFU.
   *
   * O analisador é só uma derivação — não tem nada ligado na saída dele — então
   * não concorre com o caminho de áudio do LiveKit.
   */
  private setupVAD() {
    this.teardownVAD();
    const track = this.microphonePublication()?.track?.mediaStreamTrack;
    if (!track) return;

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const context: AudioContext = new AudioCtx();
      // Em alguns navegadores o contexto nasce suspenso e a medição ficaria em zero
      context.resume().catch(() => {});
      const analyser = context.createAnalyser();
      analyser.fftSize = ANALYSER_FFT_SIZE;
      context.createMediaStreamSource(new MediaStream([track])).connect(analyser);

      this.audioContext = context;
      this.levelMeter = createLevelMeter(analyser);
      this.speechGate = createSpeechGate();
      this.vadInterval = setInterval(() => this.tickVAD(), 50);
    } catch (e) {
      console.warn('Erro ao medir o microfone no SFU:', e);
    }
  }

  private tickVAD() {
    if (!this.levelMeter || !this.speechGate) return;
    if (this.isMuted) {
      this.levelMeter.reset();
      this.speechGate.reset();
      this.setLocalSpeaking(false);
      return;
    }
    this.setLocalSpeaking(this.speechGate.update(this.levelMeter.read()));
  }

  private teardownVAD() {
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    this.levelMeter = null;
    this.speechGate = null;
    this.isSpeaking = false;
  }

  private setLocalSpeaking(speaking: boolean) {
    if (speaking === this.isSpeaking) return;
    this.isSpeaking = speaking;

    const me = this.currentUser?.id;
    const participant = me ? this.participants.get(me) : undefined;
    if (participant) {
      participant.speaking = speaking;
      this.notifyParticipants();
    }
    // Também alimenta a lista do canal, para quem não está na chamada
    this.broadcastSpeaking(speaking);
  }

  /**
   * Reserva para os participantes que ainda não anunciaram a própria fala: app
   * antigo, ou quem acabou de entrar. Quem anuncia manda no próprio indicador,
   * porque a sensibilidade é de quem fala, não de quem ouve.
   */
  private handleSpeakers(speakers: Participant[]) {
    const speaking = new Set(speakers.map((s) => s.identity));
    let changed = false;

    this.participants.forEach((participant, id) => {
      if (id === this.currentUser?.id || this.speakingFromPeers.has(id)) return;
      const next = speaking.has(id);
      if (participant.speaking !== next) {
        participant.speaking = next;
        changed = true;
      }
    });

    if (changed) this.notifyParticipants();
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
    if (event.channelId !== this.currentChannelId) return;
    const { userId, deafened } = event.data ?? {};
    if (!userId || userId === this.currentUser?.id) return;

    if (event.type === 'voice-speaking') {
      // O servidor carimba o userId com quem enviou, então isto não dá para forjar
      this.speakingFromPeers.add(userId);
      const speaker = this.participants.get(userId);
      if (speaker && speaker.speaking !== !!event.data?.speaking) {
        speaker.speaking = !!event.data?.speaking;
        this.notifyParticipants();
      }
      return;
    }

    if (event.type !== 'voice-state') return;

    this.remoteDeafened.set(userId, !!deafened);
    const participant = this.participants.get(userId);
    if (participant) {
      participant.deafened = !!deafened;
      this.notifyParticipants();
    }
  }

  private sendJoin() {
    if (!this.currentChannelId || !this.currentUser) return;
    realtimeSocket.send({
      type: 'voice-join',
      channelId: this.currentChannelId,
      data: {
        userId: this.currentUser.id,
        name: this.currentUser.name,
        avatar: this.currentUser.avatar,
        muted: this.isMuted,
        deafened: this.isDeafened,
        streaming: this.localScreen !== null,
      },
    });
  }

  private broadcastVoiceState() {
    if (!this.currentChannelId) return;
    realtimeSocket.send({
      type: 'voice-state',
      channelId: this.currentChannelId,
      data: { muted: this.isMuted, deafened: this.isDeafened },
    });
  }

  private broadcastSpeaking(speaking: boolean) {
    if (!this.currentChannelId || !this.currentUser) return;
    realtimeSocket.send({
      type: 'voice-speaking',
      channelId: this.currentChannelId,
      data: { userId: this.currentUser.id, speaking },
    });
  }

  private sendScreenEvent(type: 'screen-start' | 'screen-stop') {
    if (!this.currentChannelId || !this.currentUser) return;
    realtimeSocket.send({ type, channelId: this.currentChannelId, data: { userId: this.currentUser.id } });
  }

  // ---------- Estado observável ----------

  subscribeInputStatus = (cb: () => void) => {
    this.inputListeners.add(cb);
    return () => {
      this.inputListeners.delete(cb);
    };
  };

  getInputStatus = (): InputStatus => this.inputStatus;

  private setInputStatus(status: InputStatus) {
    if (this.inputStatus === status) return;
    this.inputStatus = status;
    this.inputListeners.forEach((cb) => cb());
  }

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

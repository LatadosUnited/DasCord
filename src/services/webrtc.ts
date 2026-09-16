import { useSyncExternalStore } from 'react';
import { realtimeSocket, SocketEvent } from './socket';
import { ICE_SERVERS } from './config';
import {
  ANALYSER_FFT_SIZE,
  applyOutputDevice,
  audioInputConstraints,
  createLevelMeter,
  createSpeechGate,
  getVoiceSettings,
  LevelMeter,
  SpeechGate,
  screenQualityPreset,
  ScreenQualityPreset,
  screenVideoConstraints,
  subscribeVoiceSettings,
} from './voiceSettings';
import { PeerConnectionStatus, User, VoiceParticipant } from '../types';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: ICE_SERVERS,
};

/** "disconnected" costuma voltar sozinho (troca de rede rápida); só reinicia o ICE depois disso */
const ICE_DISCONNECT_GRACE_MS = 4000;
/** O lado educado espera mais, para os dois não reiniciarem ao mesmo tempo */
const ICE_POLITE_EXTRA_DELAY_MS = 2500;
const ICE_RESTART_RETRY_MS = 10000;
const MAX_ICE_RESTARTS = 5;

/** ok: microfone escolhido; fallback: o escolhido sumiu e usamos o padrão; unavailable: nenhum */
export type InputStatus = 'ok' | 'fallback' | 'unavailable';

type ParticipantsListener = (participants: VoiceParticipant[]) => void;

/** Conexão com um participante, negociada no padrão "perfect negotiation" */
interface PeerLink {
  pc: RTCPeerConnection;
  /** Em ofertas cruzadas, o lado educado desiste da sua e aceita a do outro */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  audio: HTMLAudioElement | null;
  /** Leva a nossa tela a este participante; reaproveitado entre assistir e parar */
  screenTransceiver: RTCRtpTransceiver | null;
  /** Próxima tentativa de reiniciar o ICE, se a conexão caiu */
  restartTimer: ReturnType<typeof setTimeout> | null;
  restartAttempts: number;
}

export interface ScreenShareSnapshot {
  /** Nossa transmissão, para a prévia local */
  local: MediaStream | null;
  /** Quantas pessoas estão assistindo a nossa tela */
  viewerCount: number;
  /** Participantes cuja tela escolhemos assistir */
  watching: string[];
  /** Vídeo já recebido de cada participante assistido */
  remote: Record<string, MediaStream>;
}

const EMPTY_SCREEN_SNAPSHOT: ScreenShareSnapshot = { local: null, viewerCount: 0, watching: [], remote: {} };

class WebRTCVoiceService {
  private localStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelMeter: LevelMeter | null = null;
  private speechGate: SpeechGate | null = null;
  private vadInterval: any = null;
  private isSpeaking = false;
  private currentUser: User | null = null;
  private currentChannelId: string | null = null;
  private isMuted = false;
  private isDeafened = false;

  private peers: Map<string, PeerLink> = new Map();
  private participants: Map<string, VoiceParticipant> = new Map();
  private participantsListeners: Set<ParticipantsListener> = new Set();
  private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  private socketUnsub: (() => void) | null = null;
  private statusUnsub: (() => void) | null = null;
  private peerStates: Map<string, PeerConnectionStatus> = new Map();
  private inputStatus: InputStatus = 'ok';
  private inputListeners: Set<() => void> = new Set();
  // Eventos de sinalização são tratados um de cada vez, na ordem de chegada
  private signalingChain: Promise<void> = Promise.resolve();
  // Incrementado a cada join/leave; um join que termina de aguardar com geração diferente foi cancelado
  private joinGeneration = 0;

  // Transmissão de tela
  private screenStream: MediaStream | null = null;
  private screenWatchers: Set<string> = new Set();
  private watching: Set<string> = new Set();
  private remoteScreens: Map<string, MediaStream> = new Map();
  private screenSnapshot: ScreenShareSnapshot = EMPTY_SCREEN_SNAPSHOT;
  private screenListeners: Set<() => void> = new Set();

  private appliedInputDeviceId = getVoiceSettings().inputDeviceId;
  private appliedOutputDeviceId = getVoiceSettings().outputDeviceId;
  private appliedScreenQuality = getVoiceSettings().screenQuality;

  constructor() {
    // Garante que a chamada seja encerrada ao fechar a janela/aba (evita ghost participants)
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.leave();
      });
    }
    subscribeVoiceSettings(() => this.handleVoiceSettingsChange());
    // Microfone conectado ou desconectado com a chamada aberta
    if (typeof navigator !== 'undefined') {
      navigator.mediaDevices?.addEventListener?.('devicechange', () => {
        this.handleDeviceChange().catch((e) => console.warn('Erro ao tratar troca de dispositivos:', e));
      });
    }
  }

  // Aplica na hora a troca de microfone, de saída ou de qualidade da tela feita nas configurações
  private handleVoiceSettingsChange() {
    const { inputDeviceId, outputDeviceId, screenQuality } = getVoiceSettings();

    if (outputDeviceId !== this.appliedOutputDeviceId) {
      this.appliedOutputDeviceId = outputDeviceId;
      this.peers.forEach((link) => link.audio && applyOutputDevice(link.audio, outputDeviceId));
    }

    if (inputDeviceId !== this.appliedInputDeviceId) {
      this.appliedInputDeviceId = inputDeviceId;
      if (this.currentChannelId) {
        this.switchInputDevice(inputDeviceId);
      }
    }

    if (screenQuality !== this.appliedScreenQuality) {
      this.appliedScreenQuality = screenQuality;
      if (this.screenStream) {
        this.applyScreenQuality(screenQualityPreset(screenQuality));
      }
    }
  }

  private async switchInputDevice(deviceId: string) {
    const generation = this.joinGeneration;
    const stream = await this.openMicrophone(deviceId);
    if (!stream) return;

    // Saiu do canal enquanto o novo microfone abria
    if (generation !== this.joinGeneration || !this.currentChannelId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.useInputStream(stream, 'ok');
  }

  // ---------- Microfone ----------

  /** Abre o microfone; null sem permissão ou sem dispositivo */
  private async openMicrophone(deviceId: string): Promise<MediaStream | null> {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: audioInputConstraints(deviceId), video: false });
    } catch (err) {
      console.warn('Não foi possível abrir o microfone:', err);
      return null;
    }
  }

  /** Passa a transmitir este microfone para todos os participantes, no lugar do anterior */
  private useInputStream(stream: MediaStream, status: InputStatus) {
    const track = stream.getAudioTracks()[0];
    track.enabled = !this.isMuted;
    // Dispositivo desplugado (stop() feito por nós não dispara "ended")
    track.addEventListener('ended', () => {
      if (this.localStream === stream) {
        this.handleInputLost().catch((e) => console.warn('Erro ao recuperar o microfone:', e));
      }
    });

    const previous = this.localStream;
    this.localStream = stream;
    this.peers.forEach((link) => this.sendAudioTrack(link, track, stream));
    previous?.getTracks().forEach((t) => t.stop());

    this.teardownVAD();
    this.setupVAD(stream);
    this.setInputStatus(status);
  }

  /** Coloca a trilha no transceiver de áudio do par; se ele só recebia, passa a enviar (renegocia) */
  private sendAudioTrack(link: PeerLink, track: MediaStreamTrack, stream: MediaStream) {
    const { pc } = link;
    if (pc.signalingState === 'closed') return;

    const transceiver = pc
      .getTransceivers()
      .find((t) => t.receiver.track.kind === 'audio' && t.currentDirection !== 'stopped');
    if (!transceiver) {
      pc.addTrack(track, stream);
      return;
    }
    transceiver.sender.replaceTrack(track).catch((e) => console.warn('Erro ao trocar a trilha de áudio:', e));
    transceiver.sender.setStreams(stream);
    if (transceiver.direction === 'recvonly') transceiver.direction = 'sendrecv';
    else if (transceiver.direction === 'inactive') transceiver.direction = 'sendonly';
  }

  /** O microfone em uso sumiu: tenta o padrão do sistema, senão fica só ouvindo */
  private async handleInputLost() {
    const generation = this.joinGeneration;
    const lost = this.localStream;
    const stream = await this.openMicrophone('default');

    if (generation !== this.joinGeneration || this.localStream !== lost) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }
    if (stream) {
      this.useInputStream(stream, 'fallback');
      return;
    }

    this.localStream = null;
    this.teardownVAD();
    this.stopSpeaking();
    this.setInputStatus('unavailable');
  }

  private async handleDeviceChange() {
    if (!this.currentChannelId) return;

    if (this.inputStatus === 'unavailable') {
      await this.retryMicrophone();
    } else if (this.inputStatus === 'fallback') {
      // O microfone escolhido nas configurações voltou
      const wanted = getVoiceSettings().inputDeviceId;
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (devices.some((d) => d.kind === 'audioinput' && d.deviceId === wanted)) {
        await this.switchInputDevice(wanted);
      }
    }
  }

  /** Tenta abrir o microfone de novo quando a chamada está sem nenhum. Devolve se conseguiu. */
  async retryMicrophone(): Promise<boolean> {
    if (!this.currentChannelId || this.localStream) return !!this.localStream;
    const generation = this.joinGeneration;
    const stream = await this.openMicrophone(getVoiceSettings().inputDeviceId);

    if (generation !== this.joinGeneration || this.localStream) {
      stream?.getTracks().forEach((track) => track.stop());
      return !!this.localStream;
    }
    if (!stream) return false;
    this.useInputStream(stream, 'ok');
    return true;
  }

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

  private stopSpeaking() {
    if (!this.isSpeaking) return;
    this.isSpeaking = false;
    const me = this.currentUser && this.participants.get(this.currentUser.id);
    if (me) {
      me.speaking = false;
      this.notifyParticipants();
    }
    this.broadcastSpeaking(false);
  }

  async join(
    channelId: string,
    user: User,
    onParticipantsUpdate: ParticipantsListener
  ) {
    this.leave();
    const generation = ++this.joinGeneration;

    this.currentChannelId = channelId;
    this.currentUser = user;

    // Evita vazamento de memória limpando listeners anteriores
    this.participantsListeners.clear();
    this.participantsListeners.add(onParticipantsUpdate);

    // Adiciona o usuário local na lista de participantes
    this.participants.set(user.id, {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      speaking: false,
      muted: this.isMuted,
      deafened: this.isDeafened,
      streaming: false,
    });
    this.notifyParticipants();

    // Captura o microfone do usuário
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: audioInputConstraints(getVoiceSettings().inputDeviceId),
        video: false,
      });
    } catch (err) {
      console.warn('Microfone físico não acessível ou permissão negada, utilizando áudio simulado:', err);
    }

    // leave() ou outro join() aconteceu enquanto aguardávamos a permissão do microfone
    if (generation !== this.joinGeneration) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }

    if (stream) {
      this.useInputStream(stream, 'ok');
    } else {
      // Entra só ouvindo; um microfone conectado depois é usado automaticamente
      this.setInputStatus('unavailable');
    }

    // Escuta eventos de sinalização no WebSocket
    this.socketUnsub = realtimeSocket.subscribeMessages((event: SocketEvent) => {
      this.signalingChain = this.signalingChain
        .then(() => this.handleSignalingEvent(event, generation))
        .catch((e) => console.warn('Erro na sinalização de voz:', e));
    });

    // Notifica outros participantes de que entramos no canal
    this.sendJoin();

    // Se o WebSocket cair e voltar, o servidor esqueceu que estamos no canal: entra de novo
    let initialStatus = true;
    this.statusUnsub = realtimeSocket.subscribeStatus((connected) => {
      if (initialStatus) {
        initialStatus = false;
        return;
      }
      if (connected && generation === this.joinGeneration) this.sendJoin();
    });
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
        streaming: !!this.screenStream,
      },
    });
  }

  /** Mostra para o servidor inteiro se estamos mutados ou ensurdecidos */
  private broadcastVoiceState() {
    if (!this.currentChannelId || !this.currentUser) return;
    realtimeSocket.send({
      type: 'voice-state',
      channelId: this.currentChannelId,
      data: { muted: this.isMuted, deafened: this.isDeafened },
    });
  }

  leave() {
    this.joinGeneration++;

    if (this.currentChannelId && this.currentUser) {
      realtimeSocket.send({
        type: 'voice-leave',
        channelId: this.currentChannelId,
        data: {
          userId: this.currentUser.id,
        },
      });
    }

    // Para captura do microfone
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    this.teardownVAD();

    // voice-leave já avisa quem estava assistindo
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
    this.screenWatchers.clear();
    this.watching.clear();
    this.remoteScreens.clear();

    // Fecha conexões P2P e remove elementos de áudio
    this.peers.forEach((link) => this.closeLink(link));
    this.peers.clear();
    this.pendingCandidates.clear();

    if (this.socketUnsub) {
      this.socketUnsub();
      this.socketUnsub = null;
    }
    this.statusUnsub?.();
    this.statusUnsub = null;
    this.signalingChain = Promise.resolve();

    this.participants.clear();
    this.peerStates.clear();
    this.isSpeaking = false;
    this.setInputStatus('ok');
    this.notifyParticipants();
    this.notifyScreen();
    this.participantsListeners.clear();
    this.currentChannelId = null;
    this.currentUser = null;
  }

  setMuted(muted: boolean) {
    this.isMuted = muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
    if (this.currentUser) {
      const me = this.participants.get(this.currentUser.id);
      if (me) {
        me.muted = muted;
        if (muted) me.speaking = false;
        this.notifyParticipants();
      }
      this.broadcastSpeaking(false);
      this.broadcastVoiceState();
    }
  }

  setDeafened(deafened: boolean) {
    this.isDeafened = deafened;
    this.peers.forEach((link) => {
      if (link.audio) link.audio.muted = deafened;
    });
    if (this.currentUser) {
      const me = this.participants.get(this.currentUser.id);
      if (me) {
        me.deafened = deafened;
        this.notifyParticipants();
      }
      this.broadcastVoiceState();
    }
  }

  // ---------- Transmissão de tela ----------

  /** Abre o seletor de tela e começa a transmitir. Devolve uma mensagem de erro, ou null. */
  async startScreenShare(): Promise<string | null> {
    if (!this.currentChannelId || !this.currentUser || this.screenStream) return null;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return 'Este aplicativo não permite capturar a tela.';
    }

    const generation = this.joinGeneration;
    const preset = screenQualityPreset(getVoiceSettings().screenQuality);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: screenVideoConstraints(preset),
        audio: false,
      });
    } catch (err) {
      // Fechar o seletor sem escolher nada não é erro
      if (err instanceof DOMException && err.name === 'NotAllowedError') return null;
      console.warn('Não foi possível capturar a tela:', err);
      return 'Não foi possível capturar a tela.';
    }

    // Saiu do canal (ou já começou outra transmissão) enquanto o seletor estava aberto
    if (generation !== this.joinGeneration || this.screenStream) {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }

    const track = stream.getVideoTracks()[0];
    track.contentHint = preset.contentHint;
    // Botão "Parar de compartilhar" do próprio sistema
    track.addEventListener('ended', () => {
      if (this.screenStream === stream) this.stopScreenShare();
    });

    this.screenStream = stream;
    this.appliedScreenQuality = preset.id;
    this.setLocalStreaming(true);
    realtimeSocket.send({
      type: 'screen-start',
      channelId: this.currentChannelId,
      data: { userId: this.currentUser.id },
    });
    return null;
  }

  stopScreenShare() {
    if (!this.screenStream) return;

    this.screenWatchers.forEach((peerId) => this.detachScreen(peerId));
    this.screenWatchers.clear();
    this.screenStream.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
    this.setLocalStreaming(false);

    if (this.currentChannelId && this.currentUser) {
      realtimeSocket.send({
        type: 'screen-stop',
        channelId: this.currentChannelId,
        data: { userId: this.currentUser.id },
      });
    }
  }

  /** Pede a quem está transmitindo para começar a enviar a tela para nós */
  watchScreen(peerId: string) {
    if (!this.currentChannelId || !this.currentUser || this.watching.has(peerId)) return;
    if (!this.participants.get(peerId)?.streaming) return;

    this.watching.add(peerId);
    this.notifyScreen();
    realtimeSocket.send({
      type: 'screen-watch',
      channelId: this.currentChannelId,
      data: { from: this.currentUser.id, to: peerId },
    });
  }

  stopWatchingScreen(peerId: string) {
    if (!this.watching.has(peerId)) return;

    this.forgetWatching(peerId);
    if (this.currentChannelId && this.currentUser) {
      realtimeSocket.send({
        type: 'screen-unwatch',
        channelId: this.currentChannelId,
        data: { from: this.currentUser.id, to: peerId },
      });
    }
  }

  subscribeScreenShare = (cb: () => void) => {
    this.screenListeners.add(cb);
    return () => {
      this.screenListeners.delete(cb);
    };
  };

  getScreenShareSnapshot = (): ScreenShareSnapshot => this.screenSnapshot;

  private setLocalStreaming(streaming: boolean) {
    if (this.currentUser) {
      const me = this.participants.get(this.currentUser.id);
      if (me) me.streaming = streaming;
    }
    this.notifyParticipants();
    this.notifyScreen();
  }

  private forgetWatching(peerId: string) {
    this.watching.delete(peerId);
    this.remoteScreens.delete(peerId);
    this.notifyScreen();
  }

  private attachScreen(peerId: string) {
    const link = this.peers.get(peerId);
    const stream = this.screenStream;
    const track = stream?.getVideoTracks()[0];
    if (!link || !stream || !track || link.pc.signalingState === 'closed') return;

    const preset = screenQualityPreset(getVoiceSettings().screenQuality);
    const transceiver = link.screenTransceiver;
    if (transceiver) {
      // Mudar a direção dispara a renegociação
      transceiver.sender
        .replaceTrack(track)
        .then(() => this.applySenderQuality(transceiver.sender, preset))
        .catch((e) => console.warn('Erro ao retomar envio da tela:', e));
      transceiver.direction = 'sendonly';
    } else {
      link.screenTransceiver = link.pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: [{ maxBitrate: preset.maxBitrate, maxFramerate: preset.frameRate }],
      });
    }
  }

  private detachScreen(peerId: string) {
    const link = this.peers.get(peerId);
    const transceiver = link?.screenTransceiver;
    if (!link || !transceiver || link.pc.signalingState === 'closed') return;

    transceiver.sender.replaceTrack(null).catch(() => {});
    transceiver.direction = 'inactive';
  }

  private applyScreenQuality(preset: ScreenQualityPreset) {
    const track = this.screenStream?.getVideoTracks()[0];
    if (!track) return;

    track.contentHint = preset.contentHint;
    track.applyConstraints(screenVideoConstraints(preset)).catch((e) => {
      console.warn('Não foi possível aplicar a qualidade da tela:', e);
    });
    this.screenWatchers.forEach((peerId) => {
      const sender = this.peers.get(peerId)?.screenTransceiver?.sender;
      if (sender) this.applySenderQuality(sender, preset);
    });
  }

  private applySenderQuality(sender: RTCRtpSender, preset: ScreenQualityPreset) {
    const params = sender.getParameters();
    // Antes da primeira negociação ainda não há encodings; valem os sendEncodings da criação
    if (!params.encodings?.length) return;
    params.encodings[0].maxBitrate = preset.maxBitrate;
    params.encodings[0].maxFramerate = preset.frameRate;
    sender.setParameters(params).catch((e) => console.warn('Erro ao ajustar bitrate da tela:', e));
  }

  // ---------- Detecção de fala ----------

  // Voice Activity Detection (VAD)
  private setupVAD(stream: MediaStream) {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx();
      // Em alguns navegadores o contexto nasce suspenso e o medidor ficaria parado em zero
      this.audioContext.resume().catch(() => {});
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = ANALYSER_FFT_SIZE;
      source.connect(this.analyser);

      this.levelMeter = createLevelMeter(this.analyser);
      this.speechGate = createSpeechGate();

      this.vadInterval = setInterval(() => {
        if (!this.levelMeter || !this.speechGate) return;
        if (this.isMuted) {
          this.levelMeter.reset();
          this.speechGate.reset();
          return;
        }

        // Limiar de fala ajustável em Configurações > Voz e Áudio
        const speakingNow = this.speechGate.update(this.levelMeter.read());
        if (speakingNow !== this.isSpeaking) {
          this.isSpeaking = speakingNow;
          if (this.currentUser) {
            const me = this.participants.get(this.currentUser.id);
            if (me) {
              me.speaking = speakingNow;
              this.notifyParticipants();
            }
            this.broadcastSpeaking(speakingNow);
          }
        }
        // Amostragem mais fina que a janela do analisador: o portão precisa ver os ataques
      }, 50);
    } catch (e) {
      console.warn('Erro ao configurar AnalyserNode VAD:', e);
    }
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
    this.analyser = null;
    this.levelMeter = null;
    this.speechGate = null;
    this.isSpeaking = false;
  }

  private broadcastSpeaking(speaking: boolean) {
    if (!this.currentChannelId || !this.currentUser) return;
    realtimeSocket.send({
      type: 'voice-speaking',
      channelId: this.currentChannelId,
      data: {
        userId: this.currentUser.id,
        speaking,
      },
    });
  }

  // ---------- Sinalização ----------

  // Drena candidatos ICE que chegaram antes de setRemoteDescription
  private async drainPendingCandidates(peerId: string, pc: RTCPeerConnection) {
    const queue = this.pendingCandidates.get(peerId);
    if (queue && queue.length > 0) {
      this.pendingCandidates.delete(peerId);
      for (const candidate of queue) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) {
          console.warn('Erro ao drenar ICE candidate pendente:', e);
        }
      }
    }
  }

  // Tratamento de mensagens de sinalização WebRTC recebidas pelo WebSocket
  private async handleSignalingEvent(event: SocketEvent, generation: number) {
    if (generation !== this.joinGeneration || event.channelId !== this.currentChannelId || !this.currentUser) return;

    const { type, data } = event;
    const me = this.currentUser.id;

    switch (type) {
      case 'voice-join': {
        if (data.userId === me) return;

        // Novo participante entrou
        this.participants.set(data.userId, {
          id: data.userId,
          name: data.name,
          avatar: data.avatar,
          speaking: false,
          muted: !!data.muted,
          deafened: !!data.deafened,
          streaming: !!data.streaming,
        });
        this.notifyParticipants();

        // Envia confirmação de presença (anúncio) de volta para o recém-chegado saber quem já está no canal
        realtimeSocket.send({
          type: 'voice-announce',
          channelId: event.channelId,
          data: {
            to: data.userId,
            user: {
              id: me,
              name: this.currentUser.name,
              avatar: this.currentUser.avatar,
              muted: this.isMuted,
              deafened: this.isDeafened,
              streaming: !!this.screenStream,
            },
          },
        });

        // Quem já estava no canal inicia a conexão com o recém-chegado
        this.ensurePeer(data.userId, true);
        break;
      }

      case 'voice-announce': {
        // Usuário recém-chegado recebe os dados dos usuários que já estavam no canal
        if (data.to === me && data.user) {
          this.participants.set(data.user.id, {
            id: data.user.id,
            name: data.user.name,
            avatar: data.user.avatar,
            speaking: false,
            muted: !!data.user.muted,
            deafened: !!data.user.deafened,
            streaming: !!data.user.streaming,
          });
          this.notifyParticipants();
        }
        break;
      }

      case 'voice-leave': {
        if (data.userId && data.userId !== me) {
          this.removePeer(data.userId);
        }
        break;
      }

      case 'voice-state': {
        if (data.userId === me) return;
        const participant = this.participants.get(data.userId);
        if (participant) {
          participant.muted = !!data.muted;
          participant.deafened = !!data.deafened;
          this.notifyParticipants();
        }
        break;
      }

      case 'voice-speaking': {
        const participant = this.participants.get(data.userId);
        if (participant) {
          participant.speaking = data.speaking;
          this.notifyParticipants();
        }
        break;
      }

      case 'voice-offer': {
        if (data.to !== me) return;
        const link = this.ensurePeer(data.from, false);
        const { pc } = link;

        const offerCollision = link.makingOffer || pc.signalingState !== 'stable';
        link.ignoreOffer = !link.polite && offerCollision;
        if (link.ignoreOffer) return;

        // Em colisão, o lado educado desfaz a própria oferta implicitamente
        await pc.setRemoteDescription(data.offer);
        await this.drainPendingCandidates(data.from, pc);
        await pc.setLocalDescription();
        if (generation !== this.joinGeneration) return;

        realtimeSocket.send({
          type: 'voice-answer',
          channelId: event.channelId,
          data: { from: me, to: data.from, answer: pc.localDescription },
        });
        break;
      }

      case 'voice-answer': {
        if (data.to !== me) return;
        const link = this.peers.get(data.from);
        if (!link) return;
        await link.pc.setRemoteDescription(data.answer);
        await this.drainPendingCandidates(data.from, link.pc);
        break;
      }

      case 'voice-candidate': {
        if (data.to !== me || !data.candidate) return;
        const link = this.peers.get(data.from);
        // Se remoteDescription já está pronto, adiciona imediatamente; caso contrário enfileira
        if (link && link.pc.remoteDescription) {
          try {
            await link.pc.addIceCandidate(data.candidate);
          } catch (e) {
            // Candidatos de uma oferta ignorada falham por natureza
            if (!link.ignoreOffer) console.warn('Erro ao adicionar ICE candidate:', e);
          }
        } else {
          const queue = this.pendingCandidates.get(data.from) || [];
          queue.push(data.candidate);
          this.pendingCandidates.set(data.from, queue);
        }
        break;
      }

      case 'screen-start':
      case 'screen-stop': {
        if (data.userId === me) return;
        const participant = this.participants.get(data.userId);
        if (participant) {
          participant.streaming = type === 'screen-start';
          this.notifyParticipants();
        }
        if (type === 'screen-stop') {
          this.forgetWatching(data.userId);
        }
        break;
      }

      case 'screen-watch': {
        if (data.to !== me || !this.screenStream || !this.peers.has(data.from)) return;
        this.screenWatchers.add(data.from);
        this.attachScreen(data.from);
        this.notifyScreen();
        break;
      }

      case 'screen-unwatch': {
        if (data.to !== me || !this.screenWatchers.delete(data.from)) return;
        this.detachScreen(data.from);
        this.notifyScreen();
        break;
      }
    }
  }

  // Criação e configuração do RTCPeerConnection
  private ensurePeer(peerId: string, isInitiator: boolean): PeerLink {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const link: PeerLink = {
      pc,
      polite: this.currentUser!.id < peerId,
      makingOffer: false,
      ignoreOffer: false,
      audio: null,
      screenTransceiver: null,
      restartTimer: null,
      restartAttempts: 0,
    };
    this.peers.set(peerId, link);
    this.peerStates.set(peerId, 'connecting');

    // Adiciona tracks de áudio locais
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    } else if (isInitiator) {
      // Sem microfone ainda precisamos ouvir o outro lado
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);

      if (event.track.kind === 'video') {
        // Só a tela de quem escolhemos assistir
        if (this.watching.has(peerId)) {
          this.remoteScreens.set(peerId, stream);
          this.notifyScreen();
        }
        return;
      }

      if (!link.audio) {
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.muted = this.isDeafened;
        applyOutputDevice(audio, getVoiceSettings().outputDeviceId);
        document.body.appendChild(audio);
        link.audio = audio;
      }
      link.audio.srcObject = stream;
    };

    // Queda de rede: reinicia o ICE em vez de deixar o participante mudo para sempre
    pc.onconnectionstatechange = () => this.handleConnectionState(peerId, link);

    // Candidatos ICE
    pc.onicecandidate = (event) => {
      if (event.candidate && this.currentChannelId && this.currentUser) {
        realtimeSocket.send({
          type: 'voice-candidate',
          channelId: this.currentChannelId,
          data: {
            from: this.currentUser.id,
            to: peerId,
            candidate: event.candidate,
          },
        });
      }
    };

    // Toda (re)negociação parte daqui: conexão inicial e tela entrando ou saindo
    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true;
        await pc.setLocalDescription();
        // O estado pode ter mudado até aqui; só uma oferta vai como oferta
        if (pc.localDescription?.type !== 'offer' || !this.currentChannelId || !this.currentUser) return;
        realtimeSocket.send({
          type: 'voice-offer',
          channelId: this.currentChannelId,
          data: {
            from: this.currentUser.id,
            to: peerId,
            offer: pc.localDescription,
          },
        });
      } catch (e) {
        if (pc.signalingState !== 'closed') console.error('Erro ao criar WebRTC offer:', e);
      } finally {
        link.makingOffer = false;
      }
    };

    return link;
  }

  // ---------- Recuperação da conexão ----------

  private handleConnectionState(peerId: string, link: PeerLink) {
    if (this.peers.get(peerId) !== link) return;

    switch (link.pc.connectionState) {
      case 'connected':
        link.restartAttempts = 0;
        this.clearRestartTimer(link);
        this.setPeerState(peerId, 'connected');
        break;
      case 'disconnected':
      case 'failed': {
        const failed = link.pc.connectionState === 'failed';
        if (link.restartAttempts >= MAX_ICE_RESTARTS) {
          this.setPeerState(peerId, 'failed');
          break;
        }
        this.setPeerState(peerId, 'reconnecting');
        const delay = (failed ? 0 : ICE_DISCONNECT_GRACE_MS) + (link.polite ? ICE_POLITE_EXTRA_DELAY_MS : 0);
        this.scheduleIceRestart(peerId, link, delay);
        break;
      }
    }
  }

  private scheduleIceRestart(peerId: string, link: PeerLink, delayMs: number) {
    if (link.restartTimer) return;
    link.restartTimer = setTimeout(() => {
      link.restartTimer = null;
      if (this.peers.get(peerId) !== link) return;
      const state = link.pc.connectionState;
      if (state !== 'disconnected' && state !== 'failed') return;

      if (link.restartAttempts >= MAX_ICE_RESTARTS) {
        console.warn(`Conexão de voz com ${peerId} não voltou após ${MAX_ICE_RESTARTS} tentativas.`);
        this.setPeerState(peerId, 'failed');
        return;
      }
      link.restartAttempts++;
      // Gera uma nova oferta com credenciais ICE novas (onnegotiationneeded)
      link.pc.restartIce();
      // Se continuar sem conexão, o estado pode não mudar mais: confere de novo depois
      this.scheduleIceRestart(peerId, link, ICE_RESTART_RETRY_MS);
    }, delayMs);
  }

  private clearRestartTimer(link: PeerLink) {
    if (link.restartTimer) {
      clearTimeout(link.restartTimer);
      link.restartTimer = null;
    }
  }

  private setPeerState(peerId: string, state: PeerConnectionStatus) {
    if (this.peerStates.get(peerId) === state) return;
    this.peerStates.set(peerId, state);
    this.notifyParticipants();
  }

  private closeLink(link: PeerLink) {
    this.clearRestartTimer(link);
    link.pc.close();
    if (link.audio) {
      link.audio.pause();
      link.audio.remove();
    }
  }

  private removePeer(peerId: string) {
    const link = this.peers.get(peerId);
    if (link) {
      this.closeLink(link);
      this.peers.delete(peerId);
    }
    this.participants.delete(peerId);
    this.peerStates.delete(peerId);
    this.pendingCandidates.delete(peerId);
    this.screenWatchers.delete(peerId);
    this.watching.delete(peerId);
    this.remoteScreens.delete(peerId);
    this.notifyParticipants();
    this.notifyScreen();
  }

  private notifyParticipants() {
    // Cópias: o React compara por referência
    const me = this.currentUser?.id;
    const list = Array.from(this.participants.values(), (p) => ({
      ...p,
      connection: p.id === me ? undefined : this.peerStates.get(p.id) ?? 'connecting',
    }));
    this.participantsListeners.forEach((cb) => cb(list));
  }

  private notifyScreen() {
    this.screenSnapshot = {
      local: this.screenStream,
      viewerCount: this.screenWatchers.size,
      watching: Array.from(this.watching),
      remote: Object.fromEntries(this.remoteScreens),
    };
    this.screenListeners.forEach((cb) => cb());
  }
}

export const webrtcVoice = new WebRTCVoiceService();

export function useScreenShare(): ScreenShareSnapshot {
  return useSyncExternalStore(webrtcVoice.subscribeScreenShare, webrtcVoice.getScreenShareSnapshot);
}

export function useInputStatus(): InputStatus {
  return useSyncExternalStore(webrtcVoice.subscribeInputStatus, webrtcVoice.getInputStatus);
}

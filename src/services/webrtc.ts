import { realtimeSocket, SocketEvent } from './socket';
import * as signal from './voiceSignaling';
import { ICE_SERVERS } from './config';
import {
  applyOutputDevice,
  getVoiceSettings,
  screenQualityPreset,
  ScreenQualityPreset,
  subscribeVoiceSettings,
} from './voiceSettings';
import { PeerConnectionStatus, User } from '../types';
import { InputStatusStore, inputDeviceExists, openMicrophone } from './microphone';
import { ParticipantRoster } from './voiceParticipants';
import { ScreenShareState } from './screenShareState';
import { applySenderQuality, applyTrackQuality, captureScreen } from './screenCapture';
import { IceRecovery } from './iceRestart';
import { SpeakingDetector, startSpeakingDetector } from './vad';
import { InputStatus, ParticipantsListener } from './voiceTypes';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: ICE_SERVERS,
};

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
  /** Traz a conexão de volta quando ela cai */
  recovery: IceRecovery;
}

class WebRTCVoiceService {
  private localStream: MediaStream | null = null;
  /** Detecção de fala do nosso microfone; null quando não há microfone aberto */
  private vad: SpeakingDetector | null = null;
  private currentUser: User | null = null;
  private currentChannelId: string | null = null;
  private isMuted = false;
  private isDeafened = false;

  private peers: Map<string, PeerLink> = new Map();
  private roster = new ParticipantRoster((p) => ({
    ...p,
    connection: p.id === this.currentUser?.id ? undefined : this.peerStates.get(p.id) ?? 'connecting',
  }));
  private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  private socketUnsub: (() => void) | null = null;
  private statusUnsub: (() => void) | null = null;
  private peerStates: Map<string, PeerConnectionStatus> = new Map();
  private input = new InputStatusStore();
  // Eventos de sinalização são tratados um de cada vez, na ordem de chegada
  private signalingChain: Promise<void> = Promise.resolve();
  // Incrementado a cada join/leave; um join que termina de aguardar com geração diferente foi cancelado
  private joinGeneration = 0;

  // Transmissão de tela
  private screen = new ScreenShareState();

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
      if (this.screen.sharing) {
        this.applyScreenQuality(screenQualityPreset(screenQuality));
      }
    }
  }

  private async switchInputDevice(deviceId: string) {
    const generation = this.joinGeneration;
    const stream = await openMicrophone(deviceId);
    if (!stream) return;

    // Saiu do canal enquanto o novo microfone abria
    if (generation !== this.joinGeneration || !this.currentChannelId) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.useInputStream(stream, 'ok');
  }

  // ---------- Microfone ----------

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
    this.input.set(status);
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
    const stream = await openMicrophone('default');

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
    this.input.set('unavailable');
  }

  private async handleDeviceChange() {
    if (!this.currentChannelId) return;

    if (this.input.get() === 'unavailable') {
      await this.retryMicrophone();
    } else if (this.input.get() === 'fallback') {
      // O microfone escolhido nas configurações voltou
      const wanted = getVoiceSettings().inputDeviceId;
      if (await inputDeviceExists(wanted)) {
        await this.switchInputDevice(wanted);
      }
    }
  }

  /** Tenta abrir o microfone de novo quando a chamada está sem nenhum. Devolve se conseguiu. */
  async retryMicrophone(): Promise<boolean> {
    if (!this.currentChannelId || this.localStream) return !!this.localStream;
    const generation = this.joinGeneration;
    const stream = await openMicrophone(getVoiceSettings().inputDeviceId);

    if (generation !== this.joinGeneration || this.localStream) {
      stream?.getTracks().forEach((track) => track.stop());
      return !!this.localStream;
    }
    if (!stream) return false;
    this.useInputStream(stream, 'ok');
    return true;
  }

  subscribeInputStatus = this.input.subscribe;

  getInputStatus = this.input.get;

  private stopSpeaking() {
    if (!this.vad?.speaking) return;
    this.vad.markSilent();
    this.applySpeaking(false);
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
    this.roster.listen(onParticipantsUpdate);

    // Adiciona o usuário local na lista de participantes
    this.roster.upsert({
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      speaking: false,
      muted: this.isMuted,
      deafened: this.isDeafened,
      streaming: false,
    });

    // Captura o microfone do usuário; sem ele, entra só ouvindo
    const stream = await openMicrophone(getVoiceSettings().inputDeviceId);

    // leave() ou outro join() aconteceu enquanto aguardávamos a permissão do microfone
    if (generation !== this.joinGeneration) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }

    if (stream) {
      this.useInputStream(stream, 'ok');
    } else {
      // Entra só ouvindo; um microfone conectado depois é usado automaticamente
      this.input.set('unavailable');
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
    signal.sendJoin(this.currentChannelId, this.currentUser, this.presence());
  }

  /** Como os outros nos veem agora */
  private presence() {
    return { muted: this.isMuted, deafened: this.isDeafened, streaming: this.screen.sharing };
  }

  /** Mostra para o servidor inteiro se estamos mutados ou ensurdecidos */
  private broadcastVoiceState() {
    if (!this.currentChannelId || !this.currentUser) return;
    signal.sendVoiceState(this.currentChannelId, this.isMuted, this.isDeafened);
  }

  leave() {
    this.joinGeneration++;

    if (this.currentChannelId && this.currentUser) {
      signal.sendLeave(this.currentChannelId, this.currentUser.id);
    }

    // Para captura do microfone
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    this.teardownVAD();

    // voice-leave já avisa quem estava assistindo
    this.screen.local?.getTracks().forEach((track) => track.stop());
    this.screen.clear();

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

    this.roster.clear();
    this.peerStates.clear();
    this.input.set('ok');
    this.roster.notify();
    this.screen.notify();
    this.roster.clearListeners();
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
      this.roster.patch(this.currentUser.id, muted ? { muted, speaking: false } : { muted });
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
      this.roster.patch(this.currentUser.id, { deafened });
      this.broadcastVoiceState();
    }
  }

  // ---------- Transmissão de tela ----------

  /** Abre o seletor de tela e começa a transmitir. Devolve uma mensagem de erro, ou null. */
  async startScreenShare(): Promise<string | null> {
    if (!this.currentChannelId || !this.currentUser || this.screen.sharing) return null;

    const generation = this.joinGeneration;
    const preset = screenQualityPreset(getVoiceSettings().screenQuality);
    const capture = await captureScreen(preset);
    if (!capture.stream) return capture.error;
    const stream = capture.stream;

    // Saiu do canal (ou já começou outra transmissão) enquanto o seletor estava aberto
    if (generation !== this.joinGeneration || this.screen.sharing) {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }

    // Botão "Parar de compartilhar" do próprio sistema
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (this.screen.local === stream) this.stopScreenShare();
    });

    this.screen.setLocal(stream);
    this.appliedScreenQuality = preset.id;
    this.setLocalStreaming(true);
    signal.sendScreenStart(this.currentChannelId, this.currentUser.id);
    return null;
  }

  stopScreenShare() {
    const stream = this.screen.local;
    if (!stream) return;

    this.screen.watcherIds().forEach((peerId) => this.detachScreen(peerId));
    this.screen.clearWatchers();
    stream.getTracks().forEach((track) => track.stop());
    this.screen.setLocal(null);
    this.setLocalStreaming(false);

    if (this.currentChannelId && this.currentUser) {
      signal.sendScreenStop(this.currentChannelId, this.currentUser.id);
    }
  }

  /** Pede a quem está transmitindo para começar a enviar a tela para nós */
  watchScreen(peerId: string) {
    if (!this.currentChannelId || !this.currentUser || this.screen.isWatching(peerId)) return;
    if (!this.roster.isStreaming(peerId)) return;

    this.screen.startWatching(peerId);
    this.screen.notify();
    signal.sendWatchScreen(this.currentChannelId, this.currentUser.id, peerId);
  }

  stopWatchingScreen(peerId: string) {
    if (!this.screen.isWatching(peerId)) return;

    this.forgetWatching(peerId);
    if (this.currentChannelId && this.currentUser) {
      signal.sendUnwatchScreen(this.currentChannelId, this.currentUser.id, peerId);
    }
  }

  subscribeScreenShare = this.screen.subscribe;

  getScreenShareSnapshot = this.screen.getSnapshot;

  private setLocalStreaming(streaming: boolean) {
    this.roster.patch(this.currentUser?.id, { streaming });
    this.roster.notify();
    this.screen.notify();
  }

  private forgetWatching(peerId: string) {
    this.screen.forget(peerId);
    this.screen.notify();
  }

  private attachScreen(peerId: string) {
    const link = this.peers.get(peerId);
    const stream = this.screen.local;
    const track = stream?.getVideoTracks()[0];
    if (!link || !stream || !track || link.pc.signalingState === 'closed') return;

    const preset = screenQualityPreset(getVoiceSettings().screenQuality);
    const transceiver = link.screenTransceiver;
    if (transceiver) {
      // Mudar a direção dispara a renegociação
      transceiver.sender
        .replaceTrack(track)
        .then(() => applySenderQuality(transceiver.sender, preset))
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
    const track = this.screen.local?.getVideoTracks()[0];
    if (!track) return;

    applyTrackQuality(track, preset);
    this.screen.watcherIds().forEach((peerId) => {
      const sender = this.peers.get(peerId)?.screenTransceiver?.sender;
      if (sender) applySenderQuality(sender, preset);
    });
  }

  // ---------- Detecção de fala ----------

  /** Liga o detector a este microfone: falar aqui vira aviso para todo o canal */
  private setupVAD(stream: MediaStream) {
    this.vad = startSpeakingDetector(stream, {
      isMuted: () => this.isMuted,
      onChange: (speaking) => this.applySpeaking(speaking),
    });
  }

  private teardownVAD() {
    this.vad?.stop();
    this.vad = null;
  }

  /** Mostra na nossa lista e conta para os outros participantes */
  private applySpeaking(speaking: boolean) {
    if (!this.currentUser) return;
    this.roster.patch(this.currentUser.id, { speaking });
    this.broadcastSpeaking(speaking);
  }

  private broadcastSpeaking(speaking: boolean) {
    if (!this.currentChannelId || !this.currentUser) return;
    signal.sendSpeaking(this.currentChannelId, this.currentUser.id, speaking);
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
        this.roster.upsert({
          id: data.userId,
          name: data.name,
          avatar: data.avatar,
          speaking: false,
          muted: !!data.muted,
          deafened: !!data.deafened,
          streaming: !!data.streaming,
        });

        // Envia confirmação de presença (anúncio) de volta para o recém-chegado saber quem já está no canal
        signal.sendAnnounce(event.channelId, data.userId, this.currentUser, this.presence());

        // Quem já estava no canal inicia a conexão com o recém-chegado
        this.ensurePeer(data.userId, true);
        break;
      }

      case 'voice-announce': {
        // Usuário recém-chegado recebe os dados dos usuários que já estavam no canal
        if (data.to === me && data.user) {
          this.roster.upsert({
            id: data.user.id,
            name: data.user.name,
            avatar: data.user.avatar,
            speaking: false,
            muted: !!data.user.muted,
            deafened: !!data.user.deafened,
            streaming: !!data.user.streaming,
          });
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
        this.roster.patch(data.userId, { muted: !!data.muted, deafened: !!data.deafened });
        break;
      }

      case 'voice-speaking': {
        this.roster.patch(data.userId, { speaking: data.speaking });
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

        signal.sendAnswer(event.channelId, me, data.from, pc.localDescription);
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
        this.roster.patch(data.userId, { streaming: type === 'screen-start' });
        if (type === 'screen-stop') {
          this.forgetWatching(data.userId);
        }
        break;
      }

      case 'screen-watch': {
        if (data.to !== me || !this.screen.sharing || !this.peers.has(data.from)) return;
        this.screen.addWatcher(data.from);
        this.attachScreen(data.from);
        this.screen.notify();
        break;
      }

      case 'screen-unwatch': {
        if (data.to !== me || !this.screen.removeWatcher(data.from)) return;
        this.detachScreen(data.from);
        this.screen.notify();
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
      recovery: new IceRecovery(pc, peerId, {
        polite: this.currentUser!.id < peerId,
        isCurrent: () => this.peers.get(peerId) === link,
        onState: (state) => this.setPeerState(peerId, state),
      }),
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
        if (this.screen.isWatching(peerId)) {
          this.screen.setRemote(peerId, stream);
          this.screen.notify();
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
    pc.onconnectionstatechange = () => link.recovery.handleConnectionState();

    // Candidatos ICE
    pc.onicecandidate = (event) => {
      if (event.candidate && this.currentChannelId && this.currentUser) {
        signal.sendCandidate(this.currentChannelId, this.currentUser.id, peerId, event.candidate);
      }
    };

    // Toda (re)negociação parte daqui: conexão inicial e tela entrando ou saindo
    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true;
        await pc.setLocalDescription();
        // O estado pode ter mudado até aqui; só uma oferta vai como oferta
        if (pc.localDescription?.type !== 'offer' || !this.currentChannelId || !this.currentUser) return;
        signal.sendOffer(this.currentChannelId, this.currentUser.id, peerId, pc.localDescription);
      } catch (e) {
        if (pc.signalingState !== 'closed') console.error('Erro ao criar WebRTC offer:', e);
      } finally {
        link.makingOffer = false;
      }
    };

    return link;
  }

  // ---------- Estado da conexão com cada participante ----------

  private setPeerState(peerId: string, state: PeerConnectionStatus) {
    if (this.peerStates.get(peerId) === state) return;
    this.peerStates.set(peerId, state);
    this.roster.notify();
  }

  private closeLink(link: PeerLink) {
    link.recovery.cancel();
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
    this.peerStates.delete(peerId);
    this.pendingCandidates.delete(peerId);
    this.screen.removePeer(peerId);
    this.roster.remove(peerId);
    this.screen.notify();
  }

}

export const webrtcVoice = new WebRTCVoiceService();

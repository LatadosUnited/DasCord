import { realtimeSocket, SocketEvent } from './socket';
import { ICE_SERVERS } from './config';
import { User, VoiceParticipant } from '../types';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: ICE_SERVERS,
};

type ParticipantsListener = (participants: VoiceParticipant[]) => void;

class WebRTCVoiceService {
  private localStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadInterval: any = null;
  private isSpeaking = false;
  private currentUser: User | null = null;
  private currentChannelId: string | null = null;
  private isMuted = false;
  private isDeafened = false;

  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private remoteAudioElements: Map<string, HTMLAudioElement> = new Map();
  private participants: Map<string, VoiceParticipant> = new Map();
  private participantsListeners: Set<ParticipantsListener> = new Set();
  private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  private socketUnsub: (() => void) | null = null;
  // Incrementado a cada join/leave; um join que termina de aguardar com geração diferente foi cancelado
  private joinGeneration = 0;

  constructor() {
    // Garante que a chamada seja encerrada ao fechar a janela/aba (evita ghost participants)
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.leave();
      });
    }
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
    });
    this.notifyParticipants();

    // Captura o microfone do usuário
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
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
      this.localStream = stream;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });
      this.setupVAD(stream);
    } else {
      this.setupMockVAD();
    }

    // Escuta eventos de sinalização no WebSocket
    this.socketUnsub = realtimeSocket.subscribeMessages((event: SocketEvent) => {
      this.handleSignalingEvent(event);
    });

    // Notifica outros participantes de que entramos no canal
    realtimeSocket.send({
      type: 'voice-join' as any,
      channelId,
      data: {
        userId: user.id,
        name: user.name,
        avatar: user.avatar,
        muted: this.isMuted,
        deafened: this.isDeafened,
      },
    });
  }

  leave() {
    this.joinGeneration++;

    if (this.currentChannelId && this.currentUser) {
      realtimeSocket.send({
        type: 'voice-leave' as any,
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

    // Limpa VAD
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    // Fecha conexões P2P
    this.peerConnections.forEach((pc) => pc.close());
    this.peerConnections.clear();
    this.pendingCandidates.clear();

    // Remove elementos de áudio
    this.remoteAudioElements.forEach((audio) => {
      audio.pause();
      audio.remove();
    });
    this.remoteAudioElements.clear();

    if (this.socketUnsub) {
      this.socketUnsub();
      this.socketUnsub = null;
    }

    this.participants.clear();
    this.notifyParticipants();
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
    }
  }

  setDeafened(deafened: boolean) {
    this.isDeafened = deafened;
    this.remoteAudioElements.forEach((audio) => {
      audio.muted = deafened;
    });
    if (this.currentUser) {
      const me = this.participants.get(this.currentUser.id);
      if (me) {
        me.deafened = deafened;
        this.notifyParticipants();
      }
    }
  }

  // Voice Activity Detection (VAD)
  private setupVAD(stream: MediaStream) {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      const buffer = new Uint8Array(this.analyser.frequencyBinCount);

      this.vadInterval = setInterval(() => {
        if (this.isMuted || !this.analyser) return;

        this.analyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i];
        }
        const average = sum / buffer.length;

        // Limiar de fala
        const speakingNow = average > 14;
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
      }, 100);
    } catch (e) {
      console.warn('Erro ao configurar AnalyserNode VAD:', e);
    }
  }

  private setupMockVAD() {
    // Simula detecção visual quando não há microfone
    let mockToggle = false;
    this.vadInterval = setInterval(() => {
      if (this.isMuted) {
        if (this.isSpeaking) {
          this.isSpeaking = false;
          this.broadcastSpeaking(false);
        }
        return;
      }
      mockToggle = !mockToggle;
      if (mockToggle && Math.random() > 0.6) {
        this.isSpeaking = true;
      } else {
        this.isSpeaking = false;
      }
      if (this.currentUser) {
        const me = this.participants.get(this.currentUser.id);
        if (me) {
          me.speaking = this.isSpeaking;
          this.notifyParticipants();
        }
        this.broadcastSpeaking(this.isSpeaking);
      }
    }, 1500);
  }

  private broadcastSpeaking(speaking: boolean) {
    if (!this.currentChannelId || !this.currentUser) return;
    realtimeSocket.send({
      type: 'voice-speaking' as any,
      channelId: this.currentChannelId,
      data: {
        userId: this.currentUser.id,
        speaking,
      },
    });
  }

  // Drena candidatos ICE que chegaram antes de setRemoteDescription
  private async drainPendingCandidates(peerId: string, pc: RTCPeerConnection) {
    const queue = this.pendingCandidates.get(peerId);
    if (queue && queue.length > 0) {
      for (const candidate of queue) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('Erro ao drenar ICE candidate pendente:', e);
        }
      }
      this.pendingCandidates.delete(peerId);
    }
  }

  // Tratamento de mensagens de sinalização WebRTC recebidas pelo WebSocket
  private async handleSignalingEvent(event: SocketEvent) {
    if (event.channelId !== this.currentChannelId) return;

    const { type, data } = event as any;

    switch (type) {
      case 'voice-join': {
        if (!this.currentUser || data.userId === this.currentUser.id) return;

        // Novo participante entrou
        this.participants.set(data.userId, {
          id: data.userId,
          name: data.name,
          avatar: data.avatar,
          speaking: false,
          muted: !!data.muted,
          deafened: !!data.deafened,
        });
        this.notifyParticipants();

        // Envia confirmação de presença (anúncio) de volta para o recém-chegado saber quem já está no canal
        realtimeSocket.send({
          type: 'voice-announce' as any,
          channelId: this.currentChannelId!,
          data: {
            to: data.userId,
            user: {
              id: this.currentUser.id,
              name: this.currentUser.name,
              avatar: this.currentUser.avatar,
              muted: this.isMuted,
              deafened: this.isDeafened,
            },
          },
        });

        // Usuário existente cria oferta para o novo participante
        this.createPeerConnection(data.userId, true);
        break;
      }

      case 'voice-announce': {
        // Usuário recém-chegado recebe os dados dos usuários que já estavam no canal
        if (this.currentUser && data.to === this.currentUser.id && data.user) {
          this.participants.set(data.user.id, {
            id: data.user.id,
            name: data.user.name,
            avatar: data.user.avatar,
            speaking: false,
            muted: !!data.user.muted,
            deafened: !!data.user.deafened,
          });
          this.notifyParticipants();
        }
        break;
      }

      case 'voice-leave': {
        if (data.userId) {
          this.participants.delete(data.userId);
          this.pendingCandidates.delete(data.userId);
          const pc = this.peerConnections.get(data.userId);
          if (pc) {
            pc.close();
            this.peerConnections.delete(data.userId);
          }
          const audio = this.remoteAudioElements.get(data.userId);
          if (audio) {
            audio.remove();
            this.remoteAudioElements.delete(data.userId);
          }
          this.notifyParticipants();
        }
        break;
      }

      case 'voice-speaking': {
        if (data.userId && this.participants.has(data.userId)) {
          const participant = this.participants.get(data.userId)!;
          participant.speaking = data.speaking;
          this.notifyParticipants();
        }
        break;
      }

      case 'voice-offer': {
        if (this.currentUser && data.to === this.currentUser.id) {
          const pc = this.createPeerConnection(data.from, false);
          await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
          await this.drainPendingCandidates(data.from, pc);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          realtimeSocket.send({
            type: 'voice-answer' as any,
            channelId: this.currentChannelId!,
            data: {
              from: this.currentUser.id,
              to: data.from,
              answer,
            },
          });
        }
        break;
      }

      case 'voice-answer': {
        if (this.currentUser && data.to === this.currentUser.id) {
          const pc = this.peerConnections.get(data.from);
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            await this.drainPendingCandidates(data.from, pc);
          }
        }
        break;
      }

      case 'voice-candidate': {
        if (this.currentUser && data.to === this.currentUser.id && data.candidate) {
          const pc = this.peerConnections.get(data.from);
          // Se remoteDescription já está pronto, adiciona imediatamente; caso contrário enfileira
          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (e) {
              console.warn('Erro ao adicionar ICE candidate:', e);
            }
          } else {
            const queue = this.pendingCandidates.get(data.from) || [];
            queue.push(data.candidate);
            this.pendingCandidates.set(data.from, queue);
          }
        }
        break;
      }
    }
  }

  // Criação e configuração do RTCPeerConnection
  private createPeerConnection(peerId: string, isInitiator: boolean): RTCPeerConnection {
    if (this.peerConnections.has(peerId)) {
      return this.peerConnections.get(peerId)!;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.peerConnections.set(peerId, pc);

    // Adiciona tracks de áudio locais
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    // Recebe tracks de áudio do participante remoto
    pc.ontrack = (event) => {
      let audio = this.remoteAudioElements.get(peerId);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.muted = this.isDeafened;
        document.body.appendChild(audio);
        this.remoteAudioElements.set(peerId, audio);
      }
      audio.srcObject = event.streams[0];
    };

    // Candidatos ICE
    pc.onicecandidate = (event) => {
      if (event.candidate && this.currentChannelId && this.currentUser) {
        realtimeSocket.send({
          type: 'voice-candidate' as any,
          channelId: this.currentChannelId,
          data: {
            from: this.currentUser.id,
            to: peerId,
            candidate: event.candidate,
          },
        });
      }
    };

    // Se formos o iniciador da chamada para esse peer, criamos o Offer
    if (isInitiator) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          if (this.currentChannelId && this.currentUser) {
            realtimeSocket.send({
              type: 'voice-offer' as any,
              channelId: this.currentChannelId,
              data: {
                from: this.currentUser.id,
                to: peerId,
                offer: pc.localDescription,
              },
            });
          }
        })
        .catch((e) => console.error('Erro ao criar WebRTC offer:', e));
    }

    return pc;
  }

  private notifyParticipants() {
    const list = Array.from(this.participants.values());
    this.participantsListeners.forEach((cb) => cb(list));
  }
}

export const webrtcVoice = new WebRTCVoiceService();

// Detecção de fala (VAD): olha o volume do microfone algumas vezes por segundo e
// avisa quando a pessoa começa ou para de falar. Não sabe nada de chamada, de
// participantes nem de socket — quem usa decide o que fazer com o aviso.
import { averageVolume, getVoiceSettings } from './voiceSettings';

/** De quanto em quanto tempo o volume é medido */
const SAMPLE_INTERVAL_MS = 100;
const FFT_SIZE = 256;

interface Options {
  /** Mudo não é silêncio: o volume continua chegando, mas ninguém ouve */
  isMuted: () => boolean;
  /** Só é chamado quando o estado muda */
  onChange: (speaking: boolean) => void;
}

export class SpeakingDetector {
  private audioContext: AudioContext;
  private analyser: AnalyserNode;
  private timer: ReturnType<typeof setInterval>;
  private isSpeaking = false;

  constructor(stream: MediaStream, private options: Options) {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioCtx();
    const source = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    source.connect(this.analyser);

    const buffer = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.timer = setInterval(() => this.sample(buffer), SAMPLE_INTERVAL_MS);
  }

  /** Se a pessoa está falando agora */
  get speaking(): boolean {
    return this.isSpeaking;
  }

  /** Esquece que estava falando, sem avisar: quem chamou já avisou por conta própria */
  markSilent() {
    this.isSpeaking = false;
  }

  stop() {
    clearInterval(this.timer);
    if (this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
  }

  private sample(buffer: Uint8Array<ArrayBuffer>) {
    if (this.options.isMuted()) return;

    // Limiar de fala ajustável em Configurações > Voz e Áudio
    const speakingNow = averageVolume(this.analyser, buffer) > getVoiceSettings().inputSensitivity;
    if (speakingNow === this.isSpeaking) return;
    this.isSpeaking = speakingNow;
    this.options.onChange(speakingNow);
  }
}

/** Começa a ouvir o microfone. Devolve null se o navegador não deixar montar o analisador. */
export function startSpeakingDetector(stream: MediaStream, options: Options): SpeakingDetector | null {
  try {
    return new SpeakingDetector(stream, options);
  } catch (e) {
    console.warn('Erro ao configurar AnalyserNode VAD:', e);
    return null;
  }
}

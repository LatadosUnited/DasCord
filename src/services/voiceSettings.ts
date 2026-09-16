import { useSyncExternalStore } from 'react';

// Preferências de voz: ficam só neste computador (localStorage)

export type ScreenQualityId = '720p30' | '1080p30' | '1080p60';

export interface VoiceSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  /** Nível (0–100) a partir do qual a fala é detectada, na mesma escala do medidor */
  inputSensitivity: number;
  /** Ouvir a própria voz durante o teste de microfone */
  monitorInput: boolean;
  screenQuality: ScreenQualityId;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  inputSensitivity: 25,
  monitorInput: true,
  screenQuality: '1080p30',
};

export interface ScreenQualityPreset {
  id: ScreenQualityId;
  label: string;
  description: string;
  width: number;
  height: number;
  frameRate: number;
  /** Limite por espectador: na malha P2P quem transmite envia uma cópia para cada um */
  maxBitrate: number;
  contentHint: 'detail' | 'motion';
}

export const SCREEN_QUALITY_PRESETS: ScreenQualityPreset[] = [
  {
    id: '720p30',
    label: '720p · 30 FPS',
    description: 'Leve, para conexões mais fracas',
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 1_500_000,
    contentHint: 'detail',
  },
  {
    id: '1080p30',
    label: '1080p · 30 FPS',
    description: 'Texto nítido, para código e documentos',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 3_000_000,
    contentHint: 'detail',
  },
  {
    id: '1080p60',
    label: '1080p · 60 FPS',
    description: 'Movimento fluido, para jogos e vídeos',
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 6_000_000,
    contentHint: 'motion',
  },
];

export function screenQualityPreset(id: ScreenQualityId): ScreenQualityPreset {
  return SCREEN_QUALITY_PRESETS.find((p) => p.id === id) ?? SCREEN_QUALITY_PRESETS[1];
}

export function screenVideoConstraints(preset: ScreenQualityPreset): MediaTrackConstraints {
  return {
    width: { ideal: preset.width, max: preset.width },
    height: { ideal: preset.height, max: preset.height },
    frameRate: { ideal: preset.frameRate, max: preset.frameRate },
  };
}

export const SENSITIVITY_MIN = 0;
export const SENSITIVITY_MAX = 100;

export function clampSensitivity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOICE_SETTINGS.inputSensitivity;
  return Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, Math.round(value)));
}

const STORAGE_KEY = 'dascord_voice_settings';
const SETTINGS_VERSION = 2;

type StoredSettings = Partial<VoiceSettings> & { version?: number };

/** A v1 guardava o limiar na média do espectro (1–60); agora a escala é percentual */
function migrate(stored: StoredSettings): Partial<VoiceSettings> {
  if (stored.version === SETTINGS_VERSION) return stored;
  const legacy = stored.inputSensitivity;
  return {
    ...stored,
    inputSensitivity:
      typeof legacy === 'number' ? clampSensitivity(legacy * 1.8) : DEFAULT_VOICE_SETTINGS.inputSensitivity,
  };
}

function load(): VoiceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VOICE_SETTINGS };
    const merged = { ...DEFAULT_VOICE_SETTINGS, ...migrate(JSON.parse(raw) as StoredSettings) };
    return { ...merged, inputSensitivity: clampSensitivity(merged.inputSensitivity) };
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

let current = load();
const listeners = new Set<() => void>();

export function getVoiceSettings(): VoiceSettings {
  return current;
}

export function updateVoiceSettings(patch: Partial<VoiceSettings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, version: SETTINGS_VERSION }));
  } catch {
    // armazenamento indisponível: vale só até fechar o app
  }
  listeners.forEach((cb) => cb());
}

export function subscribeVoiceSettings(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useVoiceSettings(): VoiceSettings {
  return useSyncExternalStore(subscribeVoiceSettings, getVoiceSettings);
}

export interface AudioDevices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

export async function listAudioDevices(): Promise<AudioDevices> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: devices.filter((d) => d.kind === 'audioinput'),
      outputs: devices.filter((d) => d.kind === 'audiooutput'),
    };
  } catch {
    return { inputs: [], outputs: [] };
  }
}

/** Os nomes dos dispositivos só aparecem depois que o acesso ao microfone é permitido */
export async function requestMicrophonePermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

export const supportsOutputSelection =
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

type SinkableAudio = HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };

export function applyOutputDevice(audio: HTMLAudioElement, deviceId: string) {
  const sinkable = audio as SinkableAudio;
  sinkable.setSinkId?.(deviceId === 'default' ? '' : deviceId).catch((err) => {
    console.warn('Não foi possível trocar a saída de áudio:', err);
  });
}

export function deviceLabel(device: MediaDeviceInfo, index: number): string {
  if (device.label) return device.label;
  return device.kind === 'audioinput' ? `Microfone ${index + 1}` : `Saída de áudio ${index + 1}`;
}

/** Aceito tanto por getUserMedia quanto pelo SDK do servidor de voz */
export interface AudioInputOptions {
  deviceId?: { ideal: string };
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export function audioInputOptions(deviceId: string): AudioInputOptions {
  return {
    // Sem permissão, o navegador lista os dispositivos com ID vazio: trata como "padrão"
    deviceId: deviceId && deviceId !== 'default' ? { ideal: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

export function audioInputConstraints(deviceId: string): MediaTrackConstraints {
  return audioInputOptions(deviceId);
}

// ---------- Medição do microfone ----------

/** Janela de ~20 ms a 48 kHz: curta o bastante para acompanhar as sílabas */
export const ANALYSER_FFT_SIZE = 1024;

/** Faixa do medidor: -60 dBFS vira 0% e 0 dBFS vira 100% */
const METER_FLOOR_DB = -60;

/**
 * Nível do microfone em 0–100, medido pela forma de onda (RMS) em decibéis.
 *
 * A média do espectro que usávamos antes diluía a voz em dezenas de faixas agudas
 * vazias: mesmo gritando a barra mal passava da metade.
 */
export function micLevel(analyser: AnalyserNode, buffer: Uint8Array): number {
  analyser.getByteTimeDomainData(buffer as Uint8Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const sample = (buffer[i] - 128) / 128;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / buffer.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  if (db <= METER_FLOOR_DB) return 0;
  return Math.min(100, (1 - db / METER_FLOOR_DB) * 100);
}

export interface LevelMeter {
  /** Nível atual em 0–100, já suavizado */
  read(): number;
  reset(): void;
}

/**
 * Sobe na hora e desce devagar (pontos por segundo). Sem isso a barra pisca a cada
 * pausa entre sílabas, porque a voz tem silêncios de dezenas de milissegundos.
 */
export function createLevelMeter(analyser: AnalyserNode, releasePerSecond = 200): LevelMeter {
  const buffer = new Uint8Array(analyser.fftSize);
  let value = 0;
  let lastAt = 0;

  return {
    read() {
      const now = performance.now();
      const elapsed = lastAt ? Math.min(0.25, (now - lastAt) / 1000) : 0;
      lastAt = now;
      const raw = micLevel(analyser, buffer);
      value = raw >= value ? raw : Math.max(raw, value - releasePerSecond * elapsed);
      return value;
    },
    reset() {
      value = 0;
      lastAt = 0;
    },
  };
}

/** Margem para fechar o portão: evita liga-desliga quando o nível fica em cima do limiar */
const GATE_HYSTERESIS = 4;

export interface SpeechGate {
  /** Recebe o nível já suavizado e devolve se a pessoa está falando */
  update(level: number): boolean;
  reset(): void;
}

/**
 * Histerese mais tempo de espera: só considera que a fala parou depois de `holdMs`
 * abaixo do limiar. É o que impede o indicador de picotar no meio de uma frase.
 */
export function createSpeechGate(holdMs = 320): SpeechGate {
  let open = false;
  let lastAboveAt = 0;

  return {
    update(level) {
      const threshold = getVoiceSettings().inputSensitivity;
      const now = performance.now();
      if (level >= threshold) {
        lastAboveAt = now;
        open = true;
      } else if (open && level < threshold - GATE_HYSTERESIS && now - lastAboveAt >= holdMs) {
        open = false;
      }
      return open;
    },
    reset() {
      open = false;
      lastAboveAt = 0;
    },
  };
}

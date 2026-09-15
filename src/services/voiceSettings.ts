import { useSyncExternalStore } from 'react';

// Preferências de voz: ficam só neste computador (localStorage)

export type ScreenQualityId = '720p30' | '1080p30' | '1080p60';

export interface VoiceSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  /** Volume médio (0–255) a partir do qual a fala é detectada */
  inputSensitivity: number;
  screenQuality: ScreenQualityId;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  inputSensitivity: 14,
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

export const SENSITIVITY_MIN = 1;
export const SENSITIVITY_MAX = 60;

const STORAGE_KEY = 'dascord_voice_settings';

function load(): VoiceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_VOICE_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_VOICE_SETTINGS };
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
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

/** Volume médio (0–255) de um AnalyserNode */
export function averageVolume(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteFrequencyData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i];
  return sum / buffer.length;
}

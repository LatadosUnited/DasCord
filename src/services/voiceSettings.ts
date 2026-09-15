import { useSyncExternalStore } from 'react';

// Preferências de voz: ficam só neste computador (localStorage)

export interface VoiceSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  /** Volume médio (0–255) a partir do qual a fala é detectada */
  inputSensitivity: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  inputSensitivity: 14,
};

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

export function audioInputConstraints(deviceId: string): MediaTrackConstraints {
  return {
    // Sem permissão, o navegador lista os dispositivos com ID vazio: trata como "padrão"
    deviceId: deviceId && deviceId !== 'default' ? { ideal: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

/** Volume médio (0–255) de um AnalyserNode */
export function averageVolume(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteFrequencyData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i];
  return sum / buffer.length;
}

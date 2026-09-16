// O microfone e a situação dele, iguais para os dois motores de voz: abrir o
// dispositivo escolhido e contar para a interface quando ele não está disponível.
import { audioInputConstraints } from './voiceSettings';
import { InputStatus } from './voiceTypes';

/** Abre o microfone; null sem permissão ou sem dispositivo */
export async function openMicrophone(deviceId: string): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: audioInputConstraints(deviceId),
      video: false,
    });
  } catch (err) {
    console.warn('Não foi possível abrir o microfone:', err);
    return null;
  }
}

/** O microfone escolhido voltou a existir? Usado quando o sistema avisa que os dispositivos mudaram. */
export async function inputDeviceExists(deviceId: string): Promise<boolean> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.some((d) => d.kind === 'audioinput' && d.deviceId === deviceId);
}

/**
 * Situação do microfone, observável pela interface.
 * Os métodos são campos para poderem ir direto ao `useSyncExternalStore`.
 */
export class InputStatusStore {
  private status: InputStatus = 'ok';
  private listeners: Set<() => void> = new Set();

  get = (): InputStatus => this.status;

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  set(status: InputStatus) {
    if (this.status === status) return;
    this.status = status;
    this.listeners.forEach((cb) => cb());
  }
}

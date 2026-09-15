import { FC, useEffect, useState } from 'react';
import { Check, Settings } from 'lucide-react';
import {
  AudioDevices,
  deviceLabel,
  listAudioDevices,
  supportsOutputSelection,
  updateVoiceSettings,
  useVoiceSettings,
} from '../services/voiceSettings';

interface DeviceMenuProps {
  kind: 'input' | 'output';
  onOpenVoiceSettings: () => void;
  onClose: () => void;
}

/** Menu das setinhas ao lado do microfone e do fone */
export const DeviceMenu: FC<DeviceMenuProps> = ({ kind, onOpenVoiceSettings, onClose }) => {
  const settings = useVoiceSettings();
  const [devices, setDevices] = useState<AudioDevices | null>(null);

  useEffect(() => {
    listAudioDevices().then(setDevices);
  }, []);

  const list = kind === 'input' ? devices?.inputs : devices?.outputs;
  const selectedId = kind === 'input' ? settings.inputDeviceId : settings.outputDeviceId;
  const unsupported = kind === 'output' && !supportsOutputSelection;

  const select = (deviceId: string) => {
    updateVoiceSettings(kind === 'input' ? { inputDeviceId: deviceId } : { outputDeviceId: deviceId });
    onClose();
  };

  return (
    <div className={`popover-menu device-menu ${kind}`} role="menu">
      <div className="popover-title">{kind === 'input' ? 'Dispositivo de entrada' : 'Dispositivo de saída'}</div>

      <div className="popover-section">
        {devices === null && <div className="popover-hint">Carregando dispositivos...</div>}
        {unsupported && <div className="popover-hint">Este navegador não permite escolher a saída de áudio.</div>}
        {!unsupported && list && list.length === 0 && (
          <div className="popover-hint">Nenhum dispositivo encontrado.</div>
        )}
        {!unsupported &&
          list?.map((device, index) => (
            <button key={device.deviceId || index} className="popover-item" onClick={() => select(device.deviceId)}>
              <span className="device-name">{deviceLabel(device, index)}</span>
              {selectedId === device.deviceId && <Check size={16} className="device-check" />}
            </button>
          ))}
        {!unsupported && list && list.length > 0 && list.every((d) => !d.label) && (
          <div className="popover-hint">Permita o acesso ao microfone para ver os nomes dos dispositivos.</div>
        )}
      </div>

      <div className="popover-divider" />

      <div className="popover-section">
        <button
          className="popover-item"
          onClick={() => {
            onOpenVoiceSettings();
            onClose();
          }}
        >
          <Settings size={16} />
          <span>Configurações de voz</span>
        </button>
      </div>
    </div>
  );
};

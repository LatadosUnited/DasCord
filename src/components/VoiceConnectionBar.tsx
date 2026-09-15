import { FC } from 'react';
import { Wifi, PhoneOff } from 'lucide-react';
import { VoiceState } from '../types';

interface VoiceConnectionBarProps {
  voiceState: VoiceState;
  onDisconnect: () => void;
}

export const VoiceConnectionBar: FC<VoiceConnectionBarProps> = ({
  voiceState,
  onDisconnect,
}) => {
  if (!voiceState.connected) return null;

  return (
    <div className="voice-bar">
      <div className="voice-status-text">
        <span className="voice-status-title">
          <Wifi size={13} /> Voz Conectada
        </span>
        <span className="voice-channel-name">
          {voiceState.channelName} / {voiceState.pingMs}ms
        </span>
      </div>
      <button
        className="voice-disconnect-btn"
        onClick={onDisconnect}
        title="Desconectar do canal de voz"
      >
        <PhoneOff size={16} />
      </button>
    </div>
  );
};

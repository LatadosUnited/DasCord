import { FC } from 'react';
import {
  Mic,
  MicOff,
  Headphones,
  PhoneOff,
  ScreenShare,
  Wifi,
  Volume2,
} from 'lucide-react';
import { VoiceParticipant, VoiceState } from '../types';

interface VoiceStageProps {
  channelName: string;
  voiceState: VoiceState;
  participants: VoiceParticipant[];
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onDisconnect: () => void;
}

export const VoiceStage: FC<VoiceStageProps> = ({
  channelName,
  voiceState,
  participants,
  onToggleMute,
  onToggleDeafen,
  onDisconnect,
}) => {
  return (
    <div className="voice-stage-container">
      {/* Header */}
      <div className="voice-stage-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Volume2 size={20} color="#23a55a" />
          <span style={{ fontSize: '16px', fontWeight: 700, color: '#f2f3f5' }}>
            {channelName}
          </span>
          <div className="chat-divider" />
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Wifi size={14} color="#23a55a" />
            <span style={{ fontSize: '12px', color: '#23a55a', fontWeight: 600 }}>
              WebRTC Opus Conectado • {voiceState.pingMs}ms
            </span>
          </div>
        </div>
      </div>

      {/* Participants Grid */}
      <div className="voice-stage-grid">
        {participants.map((p) => {
          return (
            <div
              key={p.id}
              className={`voice-card ${p.speaking ? 'is-speaking' : ''}`}
            >
              <div className="voice-card-avatar-wrapper">
                <img
                  src={p.avatar}
                  alt={p.name}
                  className={`voice-card-avatar speaking-avatar ${
                    p.speaking ? 'is-speaking' : ''
                  }`}
                />
                {p.muted && (
                  <div className="voice-card-mic-status">
                    <MicOff size={14} color="#f23f43" />
                  </div>
                )}
              </div>
              <span className="voice-card-name">{p.name}</span>
              <span className="voice-card-sub">
                {p.speaking ? (
                  <span style={{ color: '#23a55a', fontWeight: 700 }}>Falando...</span>
                ) : p.muted ? (
                  <span style={{ color: '#f23f43' }}>Microfone Mutado</span>
                ) : (
                  'Conectado'
                )}
              </span>
            </div>
          );
        })}
      </div>

      {/* Control Dock */}
      <div className="voice-stage-controls">
        <button
          className={`voice-ctrl-btn ${voiceState.muted ? 'active-danger' : ''}`}
          onClick={onToggleMute}
          title={voiceState.muted ? 'Desativar Mudo' : 'Silenciar Microfone'}
        >
          {voiceState.muted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>

        <button
          className={`voice-ctrl-btn ${voiceState.deafened ? 'active-danger' : ''}`}
          onClick={onToggleDeafen}
          title={voiceState.deafened ? 'Ativar Som' : 'Ensurdecer'}
        >
          <Headphones size={22} />
        </button>

        <button
          className="voice-ctrl-btn"
          title="Compartilhar Tela (WebRTC Screen)"
        >
          <ScreenShare size={22} />
        </button>

        <button
          className="voice-ctrl-btn active-danger"
          onClick={onDisconnect}
          title="Desconectar da Chamada"
        >
          <PhoneOff size={22} />
        </button>
      </div>
    </div>
  );
};

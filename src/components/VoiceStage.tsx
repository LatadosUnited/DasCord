import { FC } from 'react';
import { Mic, MicOff, Headphones, PhoneOff, ScreenShare, Wifi, Volume2 } from 'lucide-react';
import { VoiceParticipant, VoiceState } from '../types';
import './VoiceStage.css';

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
      <div className="voice-stage-header">
        <Volume2 size={20} className="voice-stage-title-icon" />
        <span className="voice-stage-title">{channelName}</span>
        <div className="voice-stage-divider" />
        <div className="voice-stage-connection">
          <Wifi size={14} />
          <span>WebRTC Opus Conectado • {voiceState.pingMs}ms</span>
        </div>
      </div>

      <div className="voice-stage-grid">
        {participants.map((p) => (
          <div key={p.id} className={`voice-card ${p.speaking ? 'is-speaking' : ''}`}>
            <div className="voice-card-avatar-wrapper">
              <img
                src={p.avatar}
                alt={p.name}
                className={`voice-card-avatar speaking-avatar ${p.speaking ? 'is-speaking' : ''}`}
              />
              {p.muted && (
                <div className="voice-card-mic-status">
                  <MicOff size={14} />
                </div>
              )}
            </div>
            <span className="voice-card-name">{p.name}</span>
            <span className="voice-card-sub">
              {p.speaking ? (
                <span className="voice-speaking-label">Falando...</span>
              ) : p.muted ? (
                <span className="voice-muted-label">Microfone mutado</span>
              ) : (
                'Conectado'
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="voice-stage-controls">
        <button
          className={`voice-ctrl-btn ${voiceState.muted ? 'active-danger' : ''}`}
          onClick={onToggleMute}
          title={voiceState.muted ? 'Desativar mudo' : 'Silenciar microfone'}
        >
          {voiceState.muted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>

        <button
          className={`voice-ctrl-btn ${voiceState.deafened ? 'active-danger' : ''}`}
          onClick={onToggleDeafen}
          title={voiceState.deafened ? 'Ativar som' : 'Ensurdecer'}
        >
          <Headphones size={22} />
        </button>

        <button className="voice-ctrl-btn" title="Compartilhar tela">
          <ScreenShare size={22} />
        </button>

        <button className="voice-ctrl-btn active-danger" onClick={onDisconnect} title="Desconectar da Chamada">
          <PhoneOff size={22} />
        </button>
      </div>
    </div>
  );
};

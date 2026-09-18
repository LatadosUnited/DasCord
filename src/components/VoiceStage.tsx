import { FC, ReactNode, useEffect, useRef, useState } from 'react';
import { Check, Eye, EyeOff, Gamepad2, Maximize, Mic, MicOff, Minimize, Headphones, PhoneOff, ScreenShare, ScreenShareOff, Wifi, Volume2, X } from 'lucide-react';
import { PeerConnectionStatus, VoiceParticipant, VoiceState } from '../types';
import { useInputStatus, useScreenShare, useVoiceMode, voice } from '../services/voice';
import { SCREEN_QUALITY_PRESETS, updateVoiceSettings, useVoiceSettings } from '../services/voiceSettings';
import { ATALHO_CORTE_TEXTO, controleRemoto, useControleRemoto } from '../services/controleRemoto';
import { useCapturaControle } from '../hooks/useCapturaControle';
import { useMonitores } from '../hooks/useMonitores';
import { useLatencia } from '../hooks/useLatencia';
import { useJanelaTelaCheia } from '../hooks/useJanelaTelaCheia';
import { Latencia } from '../services/latencia';
import { useConexaoDireta } from '../services/conexaoDireta';
import './VoiceStage.css';

const CONNECTION_LABELS: Record<Exclude<PeerConnectionStatus, 'connected'>, string> = {
  connecting: 'Conectando...',
  reconnecting: 'Reconectando...',
  failed: 'Sem conexão',
};

interface VoiceStageProps {
  channelName: string;
  voiceState: VoiceState;
  participants: VoiceParticipant[];
  currentUserId: string;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onDisconnect: () => void;
}

export const VoiceStage: FC<VoiceStageProps> = ({
  channelName,
  voiceState,
  participants,
  currentUserId,
  onToggleMute,
  onToggleDeafen,
  onDisconnect,
}) => {
  const screen = useScreenShare();
  const voiceMode = useVoiceMode();
  const [screenMenuOpen, setScreenMenuOpen] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const inputStatus = useInputStatus();
  const [fallbackDismissed, setFallbackDismissed] = useState(false);
  const [retryingMic, setRetryingMic] = useState(false);

  // Um novo aviso de troca de microfone aparece mesmo que o anterior tenha sido fechado
  useEffect(() => {
    if (inputStatus !== 'fallback') setFallbackDismissed(false);
  }, [inputStatus]);

  const retryMicrophone = async () => {
    setRetryingMic(true);
    await voice.retryMicrophone();
    setRetryingMic(false);
  };

  const controle = useControleRemoto();
  const monitores = useMonitores();
  // Entrada remota só atravessa o servidor de mídia; na malha P2P o recurso não existe
  const podeControlar = voiceMode === 'sfu';

  const isStreaming = screen.local !== null;
  const hasScreens = isStreaming || screen.watching.length > 0;
  const nameOf = (id: string) => participants.find((p) => p.id === id)?.name ?? 'Participante';

  const startStreaming = async () => {
    setScreenMenuOpen(false);
    setScreenError(await voice.startScreenShare());
  };

  const stopStreaming = () => {
    setScreenMenuOpen(false);
    voice.stopScreenShare();
  };

  return (
    <div className="voice-stage-container">
      <div className="voice-stage-header">
        <Volume2 size={20} className="voice-stage-title-icon" />
        <span className="voice-stage-title">{channelName}</span>
        <div className="voice-stage-divider" />
        <div className="voice-stage-connection">
          <Wifi size={14} />
          <span>
            {voiceMode === 'p2p' ? 'WebRTC Opus • P2P' : 'WebRTC Opus • Servidor de voz'} • {voiceState.pingMs}ms
          </span>
        </div>
      </div>

      {hasScreens && (
        <div className="voice-screens">
          {screen.local && (
            <ScreenTile
              stream={screen.local}
              label="Sua tela"
              detail={
                screen.viewerCount === 0
                  ? undefined
                  : screen.viewerCount === 1
                    ? '1 assistindo'
                    : `${screen.viewerCount} assistindo`
              }
              rodape={
                podeControlar && monitores.length > 1 ? (
                  <label className="screen-tile-monitor">
                    <span>Quem controla mexe em</span>
                    <select
                      value={controle.monitor ?? ''}
                      onChange={(e) => controleRemoto.definirMonitor(e.target.value)}
                    >
                      {monitores.map((m) => (
                        <option key={m.nome} value={m.nome}>
                          {m.principal ? `${m.nome} (principal)` : m.nome} — {m.largura}×{m.altura}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : undefined
              }
            />
          )}
          {screen.watching.map((id) => (
            <TelaRemota
              key={id}
              id={id}
              streamServidor={screen.remote[id] ?? null}
              label={nameOf(id)}
              onClose={() => {
                if (controle.controlando === id) controleRemoto.encerrar();
                voice.stopWatchingScreen(id);
              }}
              controlando={controle.controlando === id}
              medirDe={id}
              telaCheia={controle.controlando === id && controle.telaCheia}
              barra={
                <BarraTelaCheia
                  nome={nameOf(id)}
                  onSair={() => controleRemoto.definirTelaCheia(false)}
                  onDevolver={() => controleRemoto.encerrar()}
                />
              }
              rodape={(temVideo) =>
                podeControlar && temVideo ? (
                  <ControleBotao
                    estado={
                      controle.controlando === id
                        ? 'controlando'
                        : controle.aguardando === id
                          ? 'aguardando'
                          : 'livre'
                    }
                    // Um controle por vez: enquanto controlamos ou esperamos alguém, não pedimos a outro
                    ocupado={
                      (controle.controlando !== null && controle.controlando !== id) ||
                      (controle.aguardando !== null && controle.aguardando !== id)
                    }
                    onPedir={() => controleRemoto.pedir(id)}
                    onCancelar={() => controleRemoto.cancelarPedido()}
                    onDevolver={() => controleRemoto.encerrar()}
                    onTelaCheia={() => controleRemoto.definirTelaCheia(true)}
                  />
                ) : undefined
              }
            />
          ))}
        </div>
      )}

      <div className={`voice-stage-grid ${hasScreens ? 'compact' : ''}`}>
        {participants.map((p) => {
          const isMe = p.id === currentUserId;
          const isWatching = screen.watching.includes(p.id);
          const connectionIssue = !isMe && p.connection && p.connection !== 'connected' ? p.connection : null;
          const unstable = connectionIssue === 'reconnecting' || connectionIssue === 'failed';
          return (
            <div
              key={p.id}
              className={`voice-card ${p.speaking ? 'is-speaking' : ''} ${unstable ? 'is-unstable' : ''}`}
            >
              {p.streaming && <span className="live-badge voice-card-live">AO VIVO</span>}
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
              {p.streaming && !isMe ? (
                <button
                  className={`voice-watch-btn ${isWatching ? 'watching' : ''}`}
                  onClick={() => (isWatching ? voice.stopWatchingScreen(p.id) : voice.watchScreen(p.id))}
                >
                  {isWatching ? <EyeOff size={14} /> : <Eye size={14} />}
                  {isWatching ? 'Parar de assistir' : 'Assistir'}
                </button>
              ) : (
                <span className="voice-card-sub">
                  {connectionIssue ? (
                    <span className={`voice-connection-label ${connectionIssue}`}>
                      {CONNECTION_LABELS[connectionIssue]}
                    </span>
                  ) : p.speaking ? (
                    <span className="voice-speaking-label">Falando...</span>
                  ) : p.muted ? (
                    <span className="voice-muted-label">Microfone mutado</span>
                  ) : (
                    'Conectado'
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {inputStatus === 'unavailable' && (
        <div className="voice-stage-error voice-stage-notice">
          <span>Nenhum microfone disponível. Você ouve a chamada, mas ninguém te escuta.</span>
          <button className="voice-notice-action" onClick={retryMicrophone} disabled={retryingMic}>
            {retryingMic ? 'Tentando...' : 'Tentar de novo'}
          </button>
        </div>
      )}

      {inputStatus === 'fallback' && !fallbackDismissed && (
        <div className="voice-stage-error voice-stage-notice">
          <span>Seu microfone foi desconectado. Usando o microfone padrão do sistema.</span>
          <button onClick={() => setFallbackDismissed(true)} title="Fechar">
            <X size={14} />
          </button>
        </div>
      )}

      {screenError && (
        <div className="voice-stage-error">
          <span>{screenError}</span>
          <button onClick={() => setScreenError(null)} title="Fechar">
            <X size={14} />
          </button>
        </div>
      )}

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

        <div className="voice-screen-control">
          {screenMenuOpen && (
            <ScreenShareMenu
              isStreaming={isStreaming}
              onStart={startStreaming}
              onStop={stopStreaming}
              onClose={() => setScreenMenuOpen(false)}
            />
          )}
          <button
            className={`voice-ctrl-btn ${isStreaming ? 'active-brand' : ''}`}
            onClick={() => setScreenMenuOpen((open) => !open)}
            title={isStreaming ? 'Transmissão de tela' : 'Compartilhar tela'}
          >
            <ScreenShare size={22} />
          </button>
        </div>

        <button className="voice-ctrl-btn active-danger" onClick={onDisconnect} title="Desconectar da Chamada">
          <PhoneOff size={22} />
        </button>
      </div>
    </div>
  );
};

interface TelaRemotaProps extends Omit<ScreenTileProps, 'stream' | 'rodape'> {
  id: string;
  streamServidor: MediaStream | null;
  rodape: (temVideo: boolean) => ReactNode;
}

/**
 * A tela de alguém: pela conexão direta quando ela está de pé (é a mesma imagem, mais
 * cedo), senão pelo servidor. Quem assiste não precisa saber a diferença, mas o selo diz.
 */
const TelaRemota: FC<TelaRemotaProps> = ({ id, streamServidor, rodape, ...resto }) => {
  const direta = useConexaoDireta(id);
  const stream = direta.caminho === 'direto' && direta.video ? direta.video : streamServidor;
  return <ScreenTile {...resto} stream={stream} rodape={rodape(stream !== null)} />;
};

interface ScreenTileProps {
  stream: MediaStream | null;
  label: string;
  detail?: string;
  onClose?: () => void;
  /** Enquanto verdadeiro, o que se faz sobre o vídeo vai para a máquina de quem transmite */
  controlando?: boolean;
  rodape?: ReactNode;
  /** De quem é a tela, para medir o atraso dela; a nossa própria não tem atraso a medir */
  medirDe?: string;
  /** Ocupa o monitor inteiro, por cima do app */
  telaCheia?: boolean;
  /** O que aparece no topo quando em tela cheia */
  barra?: ReactNode;
}

const ScreenTile: FC<ScreenTileProps> = ({
  stream,
  label,
  detail,
  onClose,
  controlando = false,
  rodape,
  medirDe,
  telaCheia = false,
  barra,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const latencia = useLatencia(medirDe && stream ? medirDe : null);
  useJanelaTelaCheia(telaCheia);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  useCapturaControle(videoRef, controlando && stream !== null);

  return (
    <div className={`screen-tile ${controlando ? 'is-controlando' : ''} ${telaCheia ? 'tela-cheia' : ''}`}>
      {stream ? (
        <video ref={videoRef} autoPlay playsInline muted />
      ) : (
        <div className="screen-tile-waiting">Conectando à transmissão...</div>
      )}
      <div className="screen-tile-label">
        <span className="live-badge">AO VIVO</span>
        <span className="screen-tile-name">{label}</span>
        {detail && <span className="screen-tile-detail">{detail}</span>}
      </div>
      {onClose && (
        <button className="screen-tile-close" onClick={onClose} title="Parar de assistir">
          <X size={16} />
        </button>
      )}
      {rodape && <div className="screen-tile-rodape">{rodape}</div>}
      {latencia && <SeloLatencia latencia={latencia} />}
      {telaCheia && barra}
    </div>
  );
};

/** Tempo que a barra fica à mostra ao entrar em tela cheia, para a pessoa saber que ela existe */
const BARRA_VISIVEL_AO_ENTRAR_MS = 3000;

interface BarraTelaCheiaProps {
  nome: string;
  onSair: () => void;
  onDevolver: () => void;
}

/**
 * Fica escondida no topo e desce quando o mouse chega lá — como no Parsec. Não dá para
 * sair por tecla: Esc, F11 e qualquer outra podem ser justamente o que o jogo lá precisa.
 */
const BarraTelaCheia: FC<BarraTelaCheiaProps> = ({ nome, onSair, onDevolver }) => {
  const [recemAberta, setRecemAberta] = useState(true);

  useEffect(() => {
    const prazo = window.setTimeout(() => setRecemAberta(false), BARRA_VISIVEL_AO_ENTRAR_MS);
    return () => window.clearTimeout(prazo);
  }, []);

  return (
    <div className="tela-cheia-topo">
      <div className={`tela-cheia-barra ${recemAberta ? 'visivel' : ''}`}>
        <Gamepad2 size={15} />
        <span className="tela-cheia-nome">
          Controlando o PC de <strong>{nome}</strong>
        </span>
        <span className="tela-cheia-dica">
          Mouse no topo para esta barra · <kbd>{ATALHO_CORTE_TEXTO}</kbd> corta
        </span>
        <button className="tela-cheia-botao" onClick={onSair} title="Sair da tela cheia sem largar o controle">
          <Minimize size={14} />
          Sair da tela cheia
        </button>
        <button className="tela-cheia-botao perigo" onClick={onDevolver}>
          Devolver controle
        </button>
      </div>
    </div>
  );
};

const ms = (valor: number | null) => (valor === null ? '—' : `${Math.round(valor)} ms`);

/** Faixas de quem joga: até 80 ms quase ninguém sente; depois de 150, todo mundo */
const faixa = (total: number | null) =>
  total === null ? '' : total <= 80 ? 'bom' : total <= 150 ? 'medio' : 'ruim';

/**
 * O número que importa para quem joga é do clique até ver o resultado. Ele vem somado
 * de partes, e as partes ficam à mostra para dar para ver qual está pesando.
 */
const SeloLatencia: FC<{ latencia: Latencia }> = ({ latencia: l }) => {
  const [aberto, setAberto] = useState(false);

  return (
    <div className="latencia">
      <button
        className={`latencia-selo ${faixa(l.total)}`}
        onClick={() => setAberto((a) => !a)}
        title="Atraso da transmissão — clique para ver de onde ele vem"
      >
        {l.total !== null ? `~${Math.round(l.total)} ms` : l.semResposta ? 'Sem ping' : 'Medindo...'}
        {l.fps !== null && <span className="latencia-fps">{Math.round(l.fps)} fps</span>}
        <span className={`latencia-caminho ${l.caminho}`}>{l.caminho === 'direto' ? 'direto' : 'servidor'}</span>
      </button>

      {aberto && (
        <div className="latencia-painel">
          <div className="latencia-linha destaque">
            <span>Do seu clique até ver na tela</span>
            <strong>{ms(l.total)}</strong>
          </div>
          <div className="latencia-linha">
            <span>Seu comando chegar lá</span>
            <span>{ms(l.entrada)}</span>
          </div>
          <div className="latencia-linha">
            <span>A imagem chegar aqui</span>
            <span>{ms(l.imagem)}</span>
          </div>

          <div className="latencia-titulo">De onde vem</div>
          <div className="latencia-linha">
            <span>Rede, ida e volta</span>
            <span>{ms(l.idaEVolta)}</span>
          </div>
          <div className="latencia-linha">
            <span>Codificar a imagem lá</span>
            <span>{ms(l.codificacao)}</span>
          </div>
          <div className="latencia-linha">
            <span>Espera contra oscilação aqui</span>
            <span>{ms(l.jitterBuffer)}</span>
          </div>
          <div className="latencia-linha">
            <span>Decodificar aqui</span>
            <span>{ms(l.decodificacao)}</span>
          </div>

          <div className="latencia-linha">
            <span>Caminho</span>
            <span>{l.caminho === 'direto' ? 'Direto entre as duas casas' : 'Pelo servidor'}</span>
          </div>

          <div className="latencia-titulo">Vídeo</div>
          <div className="latencia-linha">
            <span>{[l.resolucao, l.codec?.toUpperCase()].filter(Boolean).join(' · ') || '—'}</span>
            <span>{l.perda === null ? '' : `${(l.perda * 100).toFixed(1)}% perdido`}</span>
          </div>
          {l.relay && (
            <div className="latencia-aviso">
              Passando por um relay (TURN): um salto a mais no caminho. Costuma ser firewall ou roteador
              bloqueando conexão direta.
            </div>
          )}
          {l.semResposta && (
            <div className="latencia-aviso">
              Quem transmite não respondeu ao ping — provavelmente está numa versão anterior do DasCord. Sem a ida e
              volta, só dá para medir o que acontece deste lado.
            </div>
          )}
          <div className="latencia-nota">
            Ida e volta é medida; o resto das partes, estimado a partir dela. Sem relógio comum entre as duas
            máquinas não dá para medir só a ida.
          </div>
        </div>
      )}
    </div>
  );
};

interface ControleBotaoProps {
  estado: 'livre' | 'aguardando' | 'controlando';
  ocupado: boolean;
  onPedir: () => void;
  onCancelar: () => void;
  onDevolver: () => void;
  onTelaCheia: () => void;
}

const ControleBotao: FC<ControleBotaoProps> = ({
  estado,
  ocupado,
  onPedir,
  onCancelar,
  onDevolver,
  onTelaCheia,
}) => {
  if (estado === 'controlando') {
    return (
      <div className="screen-tile-acoes">
        <button className="screen-tile-controle" onClick={onTelaCheia} title="Voltar para a tela cheia">
          <Maximize size={14} />
          Tela cheia
        </button>
        <button className="screen-tile-controle ativo" onClick={onDevolver}>
          <Gamepad2 size={14} />
          Devolver controle
        </button>
      </div>
    );
  }
  if (estado === 'aguardando') {
    return (
      <button className="screen-tile-controle" onClick={onCancelar}>
        <Gamepad2 size={14} />
        Aguardando resposta... (cancelar)
      </button>
    );
  }
  return (
    <button className="screen-tile-controle" onClick={onPedir} disabled={ocupado}>
      <Gamepad2 size={14} />
      Pedir controle
    </button>
  );
};

interface ScreenShareMenuProps {
  isStreaming: boolean;
  onStart: () => void;
  onStop: () => void;
  onClose: () => void;
}

const ScreenShareMenu: FC<ScreenShareMenuProps> = ({ isStreaming, onStart, onStop, onClose }) => {
  const { screenQuality } = useVoiceSettings();
  const menuRef = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora (o botão que abre fica no mesmo contêiner) ou apertar Esc
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const container = menuRef.current?.parentElement;
      if (container && !container.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="popover-menu screen-share-menu" role="menu">
      <div className="popover-title">Qualidade da transmissão</div>
      <div className="popover-section">
        {SCREEN_QUALITY_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className={`popover-item ${screenQuality === preset.id ? 'selected' : ''}`}
            onClick={() => updateVoiceSettings({ screenQuality: preset.id })}
          >
            <span className="screen-quality-text">
              <span className="screen-quality-label">{preset.label}</span>
              <span className="screen-quality-desc">{preset.description}</span>
            </span>
            {screenQuality === preset.id && <Check size={16} />}
          </button>
        ))}
      </div>

      <div className="popover-divider" />

      <div className="popover-section">
        {isStreaming ? (
          <button className="popover-item danger" onClick={onStop}>
            <ScreenShareOff size={16} />
            <span>Parar transmissão</span>
          </button>
        ) : (
          <button className="popover-item accent" onClick={onStart}>
            <ScreenShare size={16} />
            <span>Transmitir tela</span>
          </button>
        )}
      </div>
    </div>
  );
};

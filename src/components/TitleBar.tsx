import { FC } from 'react';
import { Cpu, Zap, Minus, Square, X, LogOut, Lightbulb } from 'lucide-react';
import { SystemStats } from '../types';
import { RUNS_IN_TAURI, closeWindow, minimizeWindow, toggleMaximizeWindow } from '../services/appWindow';
import './TitleBar.css';

interface TitleBarProps {
  stats: SystemStats | null;
  serverOnline: boolean;
  onOpenStats: () => void;
  onLogout?: () => void;
}

export const TitleBar: FC<TitleBarProps> = ({ stats, serverOnline, onOpenStats, onLogout }) => {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
        <span className="titlebar-brand">
          <span className="brand-mark">
            <Lightbulb size={11} strokeWidth={2.5} />
          </span>
          DasCord
        </span>
        <button
          onClick={onOpenStats}
          className="titlebar-badge"
          title="Clique para ver o benchmark de performance com Rust"
        >
          <Cpu size={12} className="badge-cpu" />
          <span>Rust {stats ? `${stats.ram_usage_mb}MB RAM` : 'Tauri Core'}</span>
          <Zap size={10} className="badge-zap" />
        </button>

        <div
          className={`titlebar-badge connection ${serverOnline ? 'online' : 'offline'}`}
          title={serverOnline ? 'Servidor Rust Axum ativo na porta 3001' : 'Conectando ao servidor Rust...'}
        >
          <span className="connection-light" />
          <span>{serverOnline ? 'Axum WS Online' : 'Conectando WS...'}</span>
        </div>
      </div>

      <div className="titlebar-center">
        <span>DasCord — onde as ideias acendem</span>
      </div>

      <div className="titlebar-right">
        {onLogout && (
          <button className="titlebar-btn logout" onClick={onLogout} title="Trocar de conta">
            <LogOut size={13} />
          </button>
        )}
        {/* Só no app: no navegador quem manda na janela é o próprio navegador */}
        {RUNS_IN_TAURI && (
          <>
            <button className="titlebar-btn" title="Minimizar" onClick={minimizeWindow}>
              <Minus size={14} />
            </button>
            <button className="titlebar-btn" title="Maximizar" onClick={toggleMaximizeWindow}>
              <Square size={12} />
            </button>
            <button className="titlebar-btn close" title="Fechar" onClick={closeWindow}>
              <X size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
};

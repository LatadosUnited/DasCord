import { FC } from 'react';
import { Cpu, Zap, Minus, Square, X, LogOut } from 'lucide-react';
import { SystemStats } from '../types';

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
        <span style={{ fontWeight: 800, color: '#5865F2', fontSize: '13px' }}>DasCord</span>
        <button
          onClick={onOpenStats}
          className="titlebar-badge"
          title="Clique para ver o benchmark de performance com Rust"
          style={{ cursor: 'pointer' }}
        >
          <Cpu size={12} color="#f97316" />
          <span>Rust {stats ? `${stats.ram_usage_mb}MB RAM` : 'Tauri Core'}</span>
          <Zap size={10} color="#22c55e" />
        </button>

        <div
          className="titlebar-badge"
          style={{
            borderColor: serverOnline ? 'rgba(34, 197, 94, 0.4)' : 'rgba(148, 163, 184, 0.2)',
            backgroundColor: serverOnline ? 'rgba(34, 197, 94, 0.12)' : 'rgba(255, 255, 255, 0.04)',
            color: serverOnline ? '#86efac' : '#94a3b8',
          }}
          title={serverOnline ? 'Servidor Rust Axum ativo na porta 3001' : 'Conectando ao servidor Rust...'}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor: serverOnline ? '#22c55e' : '#94a3b8',
              boxShadow: serverOnline ? '0 0 6px #22c55e' : 'none',
            }}
          />
          <span>{serverOnline ? 'Axum WS Online' : 'Conectando WS...'}</span>
        </div>
      </div>

      <div className="titlebar-center">
        <span>DasCord — Alta Performance (Rust + Tauri v2)</span>
      </div>

      <div className="titlebar-right">
        {onLogout && (
          <button
            className="titlebar-btn"
            onClick={onLogout}
            title="Trocar de Conta / Tela de Login"
            style={{ marginRight: 6, color: '#f87171' }}
          >
            <LogOut size={13} />
          </button>
        )}
        <button className="titlebar-btn" title="Minimizar">
          <Minus size={14} />
        </button>
        <button className="titlebar-btn" title="Maximizar">
          <Square size={12} />
        </button>
        <button className="titlebar-btn close" title="Fechar">
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

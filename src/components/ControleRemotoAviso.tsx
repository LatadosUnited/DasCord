import { FC } from 'react';
import { Gamepad2, Hand, ShieldAlert } from 'lucide-react';
import { VoiceParticipant } from '../types';
import { ATALHO_CORTE_TEXTO, controleRemoto, useControleRemoto } from '../services/controleRemoto';
import { useScreenShare } from '../services/voice';
import './ControleRemotoAviso.css';

/**
 * Tudo o que envolve alguém mexendo no PC de outra pessoa aparece aqui, por cima de
 * qualquer tela do app — não só no palco de voz. Quem está sendo controlado precisa
 * ver isso sempre, e precisa do botão de cortar a um clique.
 */
export const ControleRemotoAviso: FC<{ participants: VoiceParticipant[] }> = ({ participants }) => {
  const { pedidos, permitidos, controlando, aguardando, telaCheia } = useControleRemoto();
  const transmitindo = useScreenShare().local !== null;
  const nomeDe = (id: string) => participants.find((p) => p.id === id)?.name ?? 'Alguém';

  if (!pedidos.length && !permitidos.length && !controlando && !aguardando) return null;

  return (
    <div className="controle-aviso-pilha">
      {permitidos.length > 0 && (
        <div className="controle-aviso perigo" role="alert">
          <ShieldAlert size={18} />
          <span className="controle-aviso-texto">
            <strong>{permitidos.map(nomeDe).join(', ')}</strong>{' '}
            {permitidos.length === 1 ? 'está' : 'estão'} controlando seu PC.{' '}
            <kbd>{ATALHO_CORTE_TEXTO}</kbd> corta de qualquer lugar.
          </span>
          <button className="controle-aviso-acao perigo" onClick={() => controleRemoto.cortarTudo()}>
            Cortar agora
          </button>
        </div>
      )}

      {pedidos.map((id) => (
        <div key={id} className="controle-aviso" role="alertdialog" aria-label="Pedido de controle">
          <Hand size={18} />
          <span className="controle-aviso-texto">
            <strong>{nomeDe(id)}</strong> pediu para controlar seu PC — teclado, mouse e controle. Vai poder
            fazer tudo o que você faz nele.
            {!transmitindo && ' Transmita sua tela para poder permitir.'}
          </span>
          <button
            className="controle-aviso-acao"
            onClick={() => controleRemoto.permitir(id)}
            disabled={!transmitindo}
          >
            Permitir
          </button>
          <button className="controle-aviso-acao secundaria" onClick={() => controleRemoto.negar(id)}>
            Recusar
          </button>
        </div>
      ))}

      {/* Em tela cheia quem controla já tem a barra do topo; o aviso cobriria o jogo */}
      {controlando && !telaCheia && (
        <div className="controle-aviso" role="status">
          <Gamepad2 size={18} />
          <span className="controle-aviso-texto">
            Você está controlando o PC de <strong>{nomeDe(controlando)}</strong>. Mouse sobre a tela dela, teclado
            e controle vão para lá.
          </span>
          <button className="controle-aviso-acao secundaria" onClick={() => controleRemoto.encerrar()}>
            Devolver
          </button>
        </div>
      )}

      {aguardando && (
        <div className="controle-aviso" role="status">
          <Gamepad2 size={18} />
          <span className="controle-aviso-texto">
            Esperando <strong>{nomeDe(aguardando)}</strong> responder ao seu pedido de controle...
          </span>
          <button className="controle-aviso-acao secundaria" onClick={() => controleRemoto.cancelarPedido()}>
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
};

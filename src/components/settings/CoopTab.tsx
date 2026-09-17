import { FC } from 'react';
import { AlertTriangle, Download, Gamepad2, RefreshCw, Square } from 'lucide-react';
import { BOTAO } from '../../services/controleVirtual';
import { useControleVirtual } from '../../hooks/useControleVirtual';

/** Os botões na ordem em que aparecem no painel, para conferir o espelho de olho */
const LUZES: { nome: string; mascara: number }[] = [
  { nome: 'A', mascara: BOTAO.a },
  { nome: 'B', mascara: BOTAO.b },
  { nome: 'X', mascara: BOTAO.x },
  { nome: 'Y', mascara: BOTAO.y },
  { nome: 'LB', mascara: BOTAO.lb },
  { nome: 'RB', mascara: BOTAO.rb },
  { nome: '↑', mascara: BOTAO.cima },
  { nome: '↓', mascara: BOTAO.baixo },
  { nome: '←', mascara: BOTAO.esquerda },
  { nome: '→', mascara: BOTAO.direita },
  { nome: 'Back', mascara: BOTAO.back },
  { nome: 'Start', mascara: BOTAO.start },
];

/** De -32768..32767 para a posição em porcentagem dentro da barra */
const posicaoEixo = (valor: number) => ((valor + 32768) / 65535) * 100;

export const CoopTab: FC = () => {
  const { driver, erro, ligado, origem, estado, instalando, ligar, desligar, instalar, verificar } =
    useControleVirtual();

  return (
    <div className="settings-section">
      <p className="settings-help">
        O co-op remoto dá a cada amigo um controle de Xbox 360 virtual nesta máquina, e o jogo não distingue de um
        plugado na USB. Aqui você confere se o driver desta máquina aguenta hospedar: o teste espelha um controle seu
        dentro do virtual, que é o mesmo caminho que o controle do seu amigo vai percorrer.
      </p>

      {driver === 'ausente' && (
        <div className="settings-notice coop-aviso">
          <AlertTriangle size={16} />
          <span>{instalando ? 'Instalando o driver. Aceite o aviso do Windows e aguarde.' : erro}</span>
          <div className="coop-acoes">
            <button className="btn fit" onClick={instalar} disabled={instalando}>
              <Download size={14} />
              {instalando ? 'Instalando…' : 'Instalar driver'}
            </button>
            <button className="btn secondary fit" onClick={verificar} disabled={instalando}>
              <RefreshCw size={14} />
              Verificar de novo
            </button>
          </div>
        </div>
      )}

      <section className="settings-group">
        <h3 className="settings-group-title">
          <Gamepad2 size={16} />
          Teste do controle virtual
        </h3>
        <p className="settings-help">
          Plugue um controle, aperte qualquer botão nele para o app enxergá-lo e ligue o espelho. Abra um jogo: ele
          deve ver um controle a mais.
        </p>

        <div className="coop-acoes">
          {ligado ? (
            <button className="btn secondary fit" onClick={desligar}>
              <Square size={14} />
              Parar espelho
            </button>
          ) : (
            <button className="btn fit" onClick={ligar} disabled={driver !== 'pronto'}>
              <Gamepad2 size={14} />
              Ligar espelho
            </button>
          )}
        </div>

        {origem && <p className="settings-help">Espelhando: {origem}</p>}
        {erro && driver === 'pronto' && <div className="settings-feedback error">{erro}</div>}

        {ligado && (
          <div className="coop-monitor">
            <div className="coop-luzes">
              {LUZES.map(({ nome, mascara }) => (
                <span key={nome} className={`coop-luz ${estado.botoes & mascara ? 'ativa' : ''}`}>
                  {nome}
                </span>
              ))}
            </div>

            <div className="coop-eixos">
              <label className="coop-eixo">
                <span className="settings-label">Analógico esquerdo</span>
                <span className="coop-barra">
                  <i style={{ left: `${posicaoEixo(estado.analogicoEsqX)}%` }} />
                </span>
              </label>
              <label className="coop-eixo">
                <span className="settings-label">Analógico direito</span>
                <span className="coop-barra">
                  <i style={{ left: `${posicaoEixo(estado.analogicoDirX)}%` }} />
                </span>
              </label>
              <label className="coop-eixo">
                <span className="settings-label">Gatilhos</span>
                <span className="coop-barra dupla">
                  <b style={{ width: `${(estado.gatilhoEsquerdo / 255) * 50}%` }} />
                  <b style={{ width: `${(estado.gatilhoDireito / 255) * 50}%` }} />
                </span>
              </label>
            </div>
          </div>
        )}
      </section>

      <p className="settings-help settings-footnote">
        Por este caminho passa só estado de controle — nunca teclado ou mouse. O driver é o ViGEmBus, de
        terceiros, e vai junto do DasCord: ele só é instalado quando você clica, e só quem hospeda precisa.
      </p>
    </div>
  );
};

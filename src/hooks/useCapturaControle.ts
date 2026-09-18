import { RefObject, useEffect } from 'react';
import { controleRemoto } from '../services/controleRemoto';
import { TIPO } from '../services/entradaProtocolo';
import { vkDaTecla } from '../services/entradaRemota';
import { CONTROLE_NEUTRO, EstadoControle, mesmoEstado, padraoParaXInput } from '../services/controleVirtual';

/**
 * Estado de controle vai pelo caminho que pode perder pacote. Se o último — o "soltei
 * tudo" — se perder, o botão ficaria apertado lá; então, mesmo parado, repetimos o
 * estado de tempos em tempos.
 */
const REPETIR_CONTROLE_MS = 100;

/**
 * Movimento sai na hora, com este intervalo mínimo entre um e outro: mais que isso seria
 * pacote a mais sem ganho, já que a tela do outro lado anda a 60 quadros por segundo.
 */
const INTERVALO_MOUSE_MS = 4;

/**
 * O `pointermove` do Chromium é entregue alinhado aos quadros da tela; o `pointerrawupdate`
 * chega assim que o mouse mexe. Até um quadro inteiro de diferença, só na entrada.
 */
const EVENTO_MOVIMENTO = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove';

/** A roda do mouse chega em pixels; o Windows conta em "cliques" da roda */
const PIXELS_POR_CLIQUE = 100;

/**
 * Onde, dentro do vídeo, está o ponteiro — de 0 a 1. O vídeo usa `object-fit: contain`,
 * então pode ter faixa preta dos lados ou em cima: a conta desconta isso, senão o clique
 * cairia deslocado. `null` fora da imagem.
 */
function posicaoNaImagem(video: HTMLVideoElement, clientX: number, clientY: number) {
  const caixa = video.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight) return null;
  const escala = Math.min(caixa.width / video.videoWidth, caixa.height / video.videoHeight);
  const largura = video.videoWidth * escala;
  const altura = video.videoHeight * escala;
  const x = (clientX - (caixa.left + (caixa.width - largura) / 2)) / largura;
  const y = (clientY - (caixa.top + (caixa.height - altura) / 2)) / altura;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * Enquanto `ativo`, o que a pessoa faz sobre o vídeo vira entrada na máquina de quem
 * hospeda: mouse sobre a imagem, teclado da janela inteira e o primeiro controle plugado.
 */
export function useCapturaControle(videoRef: RefObject<HTMLVideoElement | null>, ativo: boolean) {
  useEffect(() => {
    const video = videoRef.current;
    if (!ativo || !video) return;

    const teclas = new Set<number>();
    const botoes = new Set<number>();
    let posicaoPendente: { x: number; y: number } | null = null;
    let ultimoEnvioMouse = 0;
    let envioAgendado = 0;
    let controleEnviado: EstadoControle = CONTROLE_NEUTRO;
    let ultimoEnvioControle = 0;
    let quadro = 0;

    const enviarPosicao = () => {
      envioAgendado = 0;
      if (!posicaoPendente) return;
      ultimoEnvioMouse = performance.now();
      controleRemoto.enviar({ tipo: TIPO.mouseMover, ...posicaoPendente });
      posicaoPendente = null;
    };

    const aoMover = (e: Event) => {
      const { clientX, clientY } = e as PointerEvent;
      const posicao = posicaoNaImagem(video, clientX, clientY);
      if (!posicao) return;
      posicaoPendente = posicao;
      const falta = INTERVALO_MOUSE_MS - (performance.now() - ultimoEnvioMouse);
      if (falta <= 0) enviarPosicao();
      // Dentro do intervalo: a posição mais nova sai quando ele acabar, não se perde
      else if (!envioAgendado) envioAgendado = window.setTimeout(enviarPosicao, falta);
    };

    const aoApertar = (e: MouseEvent) => {
      e.preventDefault();
      if (e.button > 2) return;
      botoes.add(e.button);
      const posicao = posicaoNaImagem(video, e.clientX, e.clientY);
      // O clique leva a posição de agora; um movimento agendado sairia depois dele,
      // com a posição de antes, e arrastaria o cursor de volta
      window.clearTimeout(envioAgendado);
      envioAgendado = 0;
      posicaoPendente = null;
      if (posicao) {
        ultimoEnvioMouse = performance.now();
        controleRemoto.enviar({ tipo: TIPO.mouseMover, ...posicao });
      }
      controleRemoto.enviar({ tipo: TIPO.mouseBotao, botao: e.button, pressionado: true });
    };

    // Soltar é ouvido na janela inteira: arrastar para fora do vídeo e soltar lá
    // não pode deixar o botão preso na outra máquina
    const aoSoltar = (e: MouseEvent) => {
      if (!botoes.delete(e.button)) return;
      controleRemoto.enviar({ tipo: TIPO.mouseBotao, botao: e.button, pressionado: false });
    };

    const aoRolar = (e: WheelEvent) => {
      e.preventDefault();
      const cliques = (delta: number) =>
        delta === 0 ? 0 : Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / PIXELS_POR_CLIQUE));
      controleRemoto.enviar({ tipo: TIPO.mouseRoda, horizontal: cliques(e.deltaX), vertical: cliques(e.deltaY) });
    };

    const semMenu = (e: Event) => e.preventDefault();

    const aoTeclar = (pressionado: boolean) => (e: KeyboardEvent) => {
      const vk = vkDaTecla(e.code);
      if (vk === null) return;
      // Tab, F5, Alt... vão para lá, não para o DasCord
      e.preventDefault();
      if (pressionado) teclas.add(vk);
      else teclas.delete(vk);
      controleRemoto.enviar({ tipo: TIPO.tecla, vk, pressionado });
    };
    const aoDescer = aoTeclar(true);
    const aoSubir = aoTeclar(false);

    /**
     * Trocar de janela no meio de um "W" segurado: o "soltou" iria para a outra janela,
     * não para cá. Então, ao perder o foco, soltamos tudo do lado de lá.
     */
    const soltarTudo = () => {
      teclas.forEach((vk) => controleRemoto.enviar({ tipo: TIPO.tecla, vk, pressionado: false }));
      teclas.clear();
      botoes.forEach((botao) => controleRemoto.enviar({ tipo: TIPO.mouseBotao, botao, pressionado: false }));
      botoes.clear();
    };

    const aCadaQuadro = (agora: number) => {
      quadro = requestAnimationFrame(aCadaQuadro);

      const fisico = navigator.getGamepads().find((g): g is Gamepad => !!g);
      if (!fisico) return;
      const estado = padraoParaXInput(fisico);
      const mudou = !mesmoEstado(estado, controleEnviado);
      if (!mudou && agora - ultimoEnvioControle < REPETIR_CONTROLE_MS) return;
      controleEnviado = estado;
      ultimoEnvioControle = agora;
      controleRemoto.enviar({ tipo: TIPO.controle, ...estado });
    };

    video.addEventListener(EVENTO_MOVIMENTO, aoMover);
    video.addEventListener('mousedown', aoApertar);
    video.addEventListener('wheel', aoRolar, { passive: false });
    video.addEventListener('contextmenu', semMenu);
    window.addEventListener('mouseup', aoSoltar);
    window.addEventListener('keydown', aoDescer);
    window.addEventListener('keyup', aoSubir);
    window.addEventListener('blur', soltarTudo);
    quadro = requestAnimationFrame(aCadaQuadro);

    return () => {
      cancelAnimationFrame(quadro);
      window.clearTimeout(envioAgendado);
      video.removeEventListener(EVENTO_MOVIMENTO, aoMover);
      video.removeEventListener('mousedown', aoApertar);
      video.removeEventListener('wheel', aoRolar);
      video.removeEventListener('contextmenu', semMenu);
      window.removeEventListener('mouseup', aoSoltar);
      window.removeEventListener('keydown', aoDescer);
      window.removeEventListener('keyup', aoSubir);
      window.removeEventListener('blur', soltarTudo);
      soltarTudo();
      // O controle volta ao neutro antes de parar de mandar
      if (!mesmoEstado(controleEnviado, CONTROLE_NEUTRO)) {
        controleRemoto.enviar({ tipo: TIPO.controle, ...CONTROLE_NEUTRO });
      }
    };
  }, [videoRef, ativo]);
}

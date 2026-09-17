// Capturar a tela e manter a qualidade escolhida. Não sabe para quem o vídeo vai:
// quem chama é que decide o que fazer com o stream.
import { ScreenQualityPreset, screenVideoConstraints } from './voiceSettings';

/**
 * `stream` preenchido deu certo. Sem ele, `error` é a mensagem para mostrar à
 * pessoa — ou null quando ela apenas fechou o seletor sem escolher nada.
 */
export type ScreenCapture = { stream: MediaStream; error?: never } | { stream: null; error: string | null };

/** Abre o seletor de tela do sistema e devolve o vídeo já no formato pedido */
export async function captureScreen(preset: ScreenQualityPreset): Promise<ScreenCapture> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return { stream: null, error: 'Este aplicativo não permite capturar a tela.' };
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: screenVideoConstraints(preset),
      audio: false,
    });
    stream.getVideoTracks()[0].contentHint = preset.contentHint;
    return { stream };
  } catch (err) {
    // Fechar o seletor sem escolher nada não é erro
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      return { stream: null, error: null };
    }
    console.warn('Não foi possível capturar a tela:', err);
    return { stream: null, error: 'Não foi possível capturar a tela.' };
  }
}

/** Muda a qualidade da captura em andamento */
export function applyTrackQuality(track: MediaStreamTrack, preset: ScreenQualityPreset) {
  track.contentHint = preset.contentHint;
  track.applyConstraints(screenVideoConstraints(preset)).catch((e) => {
    console.warn('Não foi possível aplicar a qualidade da tela:', e);
  });
}

/** Muda a qualidade do que já está sendo enviado a um participante */
export function applySenderQuality(sender: RTCRtpSender, preset: ScreenQualityPreset) {
  const params = sender.getParameters();
  // Antes da primeira negociação ainda não há encodings; valem os sendEncodings da criação
  if (!params.encodings?.length) return;
  // O SFU publica a tela em camadas: o teto novo vale para a maior, e as menores
  // acompanham na mesma proporção de antes. Na malha P2P só existe uma camada.
  const highest = Math.max(...params.encodings.map((e) => e.maxBitrate ?? 0));
  params.encodings.forEach((encoding) => {
    encoding.maxFramerate = preset.frameRate;
    encoding.maxBitrate =
      highest > 0 && encoding.maxBitrate
        ? Math.round(preset.maxBitrate * (encoding.maxBitrate / highest))
        : preset.maxBitrate;
  });
  sender.setParameters(params).catch((e) => console.warn('Erro ao ajustar bitrate da tela:', e));
}

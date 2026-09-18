// O que trafega entre quem controla e quem hospeda. Formato binário e miúdo porque
// mouse e controle mandam evento a cada quadro: um pacote de movimento tem 5 bytes.
//
// Nada aqui sabe de rede nem de permissão — só transforma evento em bytes e de volta.
// Quem decide se um pacote pode ser aplicado é o app de quem hospeda.

/** Separa os pacotes de entrada de qualquer outra coisa que trafegue no data channel */
export const TOPICO_ENTRADA = 'entrada';

/** Pedir, aceitar, negar e encerrar — o combinado, que é raro e vai em JSON mesmo */
export const TOPICO_CONTROLE = 'controle';

export type MensagemControle =
  | { tipo: 'pedido' }
  | { tipo: 'aceito' }
  | { tipo: 'negado' }
  | { tipo: 'encerrado' };

export const codificarControle = (mensagem: MensagemControle): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(JSON.stringify(mensagem));

/** `null` para qualquer coisa que não seja uma das mensagens combinadas */
export function decodificarControle(dados: Uint8Array): MensagemControle | null {
  try {
    const bruto = JSON.parse(new TextDecoder().decode(dados));
    switch (bruto?.tipo) {
      case 'pedido':
      case 'aceito':
      case 'negado':
      case 'encerrado':
        return { tipo: bruto.tipo };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export const TIPO = {
  controle: 1,
  mouseMover: 2,
  mouseBotao: 3,
  mouseRoda: 4,
  tecla: 5,
} as const;

export interface PacoteControle {
  tipo: typeof TIPO.controle;
  botoes: number;
  gatilhoEsquerdo: number;
  gatilhoDireito: number;
  analogicoEsqX: number;
  analogicoEsqY: number;
  analogicoDirX: number;
  analogicoDirY: number;
}

/** `x` e `y` de 0 a 1 dentro da tela compartilhada */
export interface PacoteMouseMover {
  tipo: typeof TIPO.mouseMover;
  x: number;
  y: number;
}

export interface PacoteMouseBotao {
  tipo: typeof TIPO.mouseBotao;
  botao: number;
  pressionado: boolean;
}

export interface PacoteMouseRoda {
  tipo: typeof TIPO.mouseRoda;
  horizontal: number;
  vertical: number;
}

export interface PacoteTecla {
  tipo: typeof TIPO.tecla;
  vk: number;
  pressionado: boolean;
}

export type PacoteEntrada =
  | PacoteControle
  | PacoteMouseMover
  | PacoteMouseBotao
  | PacoteMouseRoda
  | PacoteTecla;

/**
 * Movimento e estado de controle podem ser perdidos sem estrago: vem outro logo atrás.
 * Botão e tecla, não — perder um "soltou" deixa a tecla presa na máquina de quem hospeda,
 * então esses vão pelo caminho confiável.
 */
export const ehConfiavel = (pacote: PacoteEntrada): boolean =>
  pacote.tipo === TIPO.mouseBotao || pacote.tipo === TIPO.tecla || pacote.tipo === TIPO.mouseRoda;

/** 0..1 vira 0..65535: um pixel de 4K sobra dentro dessa precisão */
const paraNormalizado = (valor: number) => Math.round(Math.max(0, Math.min(1, valor)) * 65535);

export function codificar(pacote: PacoteEntrada): Uint8Array<ArrayBuffer> {
  switch (pacote.tipo) {
    case TIPO.controle: {
      // 1 de tipo + 2 de botões + 2 de gatilhos + 8 dos quatro eixos
      const bytes = new Uint8Array(13);
      const buffer = new DataView(bytes.buffer);
      buffer.setUint8(0, pacote.tipo);
      buffer.setUint16(1, pacote.botoes);
      buffer.setUint8(3, pacote.gatilhoEsquerdo);
      buffer.setUint8(4, pacote.gatilhoDireito);
      buffer.setInt16(5, pacote.analogicoEsqX);
      buffer.setInt16(7, pacote.analogicoEsqY);
      buffer.setInt16(9, pacote.analogicoDirX);
      buffer.setInt16(11, pacote.analogicoDirY);
      return bytes;
    }
    case TIPO.mouseMover: {
      const bytes = new Uint8Array(5);
      const buffer = new DataView(bytes.buffer);
      buffer.setUint8(0, pacote.tipo);
      buffer.setUint16(1, paraNormalizado(pacote.x));
      buffer.setUint16(3, paraNormalizado(pacote.y));
      return bytes;
    }
    case TIPO.mouseBotao: {
      const bytes = new Uint8Array(3);
      const buffer = new DataView(bytes.buffer);
      buffer.setUint8(0, pacote.tipo);
      buffer.setUint8(1, pacote.botao);
      buffer.setUint8(2, pacote.pressionado ? 1 : 0);
      return bytes;
    }
    case TIPO.mouseRoda: {
      const bytes = new Uint8Array(5);
      const buffer = new DataView(bytes.buffer);
      buffer.setUint8(0, pacote.tipo);
      buffer.setInt16(1, pacote.horizontal);
      buffer.setInt16(3, pacote.vertical);
      return bytes;
    }
    case TIPO.tecla: {
      const bytes = new Uint8Array(4);
      const buffer = new DataView(bytes.buffer);
      buffer.setUint8(0, pacote.tipo);
      buffer.setUint16(1, pacote.vk);
      buffer.setUint8(3, pacote.pressionado ? 1 : 0);
      return bytes;
    }
  }
}

/**
 * `null` para qualquer coisa que não seja um pacote inteiro e conhecido. Pacote vem da
 * rede: tamanho errado ou tipo desconhecido é descartado calado, nunca aplicado pela metade.
 */
export function decodificar(dados: Uint8Array): PacoteEntrada | null {
  if (dados.length < 1) return null;
  const buffer = new DataView(dados.buffer, dados.byteOffset, dados.byteLength);

  switch (buffer.getUint8(0)) {
    case TIPO.controle:
      if (dados.length !== 13) return null;
      return {
        tipo: TIPO.controle,
        botoes: buffer.getUint16(1),
        gatilhoEsquerdo: buffer.getUint8(3),
        gatilhoDireito: buffer.getUint8(4),
        analogicoEsqX: buffer.getInt16(5),
        analogicoEsqY: buffer.getInt16(7),
        analogicoDirX: buffer.getInt16(9),
        analogicoDirY: buffer.getInt16(11),
      };
    case TIPO.mouseMover:
      if (dados.length !== 5) return null;
      return {
        tipo: TIPO.mouseMover,
        x: buffer.getUint16(1) / 65535,
        y: buffer.getUint16(3) / 65535,
      };
    case TIPO.mouseBotao:
      if (dados.length !== 3) return null;
      return {
        tipo: TIPO.mouseBotao,
        botao: buffer.getUint8(1),
        pressionado: buffer.getUint8(2) === 1,
      };
    case TIPO.mouseRoda:
      if (dados.length !== 5) return null;
      return {
        tipo: TIPO.mouseRoda,
        horizontal: buffer.getInt16(1),
        vertical: buffer.getInt16(3),
      };
    case TIPO.tecla:
      if (dados.length !== 4) return null;
      return {
        tipo: TIPO.tecla,
        vk: buffer.getUint16(1),
        pressionado: buffer.getUint8(3) === 1,
      };
    default:
      return null;
  }
}

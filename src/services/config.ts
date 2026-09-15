// Endereços do servidor e da rede de voz, configuráveis via .env (veja .env.example)

const env = import.meta.env;

export const API_URL = (env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '');

export const WS_URL = env.VITE_WS_URL || `${API_URL.replace(/^http/, 'ws')}/ws`;

// STUN só descobre o IP público; atrás de NAT restritivo a voz precisa de um relay TURN
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  ...(env.VITE_TURN_URL
    ? [
        {
          urls: env.VITE_TURN_URL.split(',').map((u) => u.trim()),
          username: env.VITE_TURN_USERNAME,
          credential: env.VITE_TURN_CREDENTIAL,
        },
      ]
    : []),
];

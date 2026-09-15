import { Server, Channel, User, Message } from './types';

export const CURRENT_USER: User = {
  id: 'u-me',
  name: 'Leandro',
  tag: '#0001',
  avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
  status: 'online',
  customStatus: '🦀 Hackeando com Rust & Tauri v2',
  role: 'Creator',
  roleColor: '#f47fff',
};

export const MOCK_USERS: User[] = [
  CURRENT_USER,
  {
    id: 'u-ferris',
    name: 'Ferris Crab',
    tag: '#1337',
    avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80',
    status: 'online',
    customStatus: 'cargo build --release',
    role: 'Rust Core Dev',
    roleColor: '#f97316',
    isBot: false,
  },
  {
    id: 'u-dascord-bot',
    name: 'DasCord Bot',
    tag: '#BOT',
    avatar: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150&auto=format&fit=crop&q=80',
    status: 'online',
    customStatus: 'Ouvindo WebSockets',
    role: 'Bots',
    roleColor: '#5865F2',
    isBot: true,
  },
  {
    id: 'u-ana',
    name: 'Ana Dev',
    tag: '#2048',
    avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80',
    status: 'idle',
    customStatus: 'Ouvindo Spotify 🎧',
    role: 'Moderator',
    roleColor: '#22c55e',
  },
  {
    id: 'u-carlos',
    name: 'Carlos Tauri',
    tag: '#8899',
    avatar: 'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=150&auto=format&fit=crop&q=80',
    status: 'dnd',
    customStatus: 'Não perturbe • Compilando kernel',
    role: 'Member',
    roleColor: '#94a3b8',
  },
  {
    id: 'u-julia',
    name: 'Julia UI',
    tag: '#5511',
    avatar: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&auto=format&fit=crop&q=80',
    status: 'offline',
    customStatus: '',
    role: 'Member',
    roleColor: '#94a3b8',
  }
];

export const MOCK_SERVERS: Server[] = [
  {
    id: 's-dasideia',
    name: 'DasIdeia HQ',
    initials: 'DI',
    gradient: 'linear-gradient(135deg, #5865f2 0%, #8b5cf6 100%)',
    unreadCount: 3,
    hasPing: true,
  },
  {
    id: 's-rustaceans',
    name: 'Rustaceans Brasil',
    initials: 'RS',
    gradient: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)',
    unreadCount: 0,
    hasPing: false,
  },
  {
    id: 's-tauri',
    name: 'Tauri Apps Official',
    initials: 'TA',
    gradient: 'linear-gradient(135deg, #22d3ee 0%, #2563eb 100%)',
    unreadCount: 12,
    hasPing: false,
  },
  {
    id: 's-gaming',
    name: 'Games & Co-op Lounge',
    initials: 'GC',
    gradient: 'linear-gradient(135deg, #10b981 0%, #047857 100%)',
    unreadCount: 0,
    hasPing: false,
  }
];

export const MOCK_CHANNELS: Channel[] = [
  // DasIdeia HQ
  {
    id: 'c-geral',
    serverId: 's-dasideia',
    name: 'geral',
    type: 'text',
    topic: 'Conversas gerais da equipe DasIdeia & novidades do DasCord',
    category: 'TEXT CHANNELS',
  },
  {
    id: 'c-rust-dev',
    serverId: 's-dasideia',
    name: 'rust-dev',
    type: 'text',
    topic: 'Desenvolvimento do backend em Rust, Axum, Tokio e Tauri IPC',
    category: 'TEXT CHANNELS',
    unread: true,
  },
  {
    id: 'c-anuncios',
    serverId: 's-dasideia',
    name: 'anúncios',
    type: 'text',
    topic: 'Comunicados importantes da comunidade',
    category: 'INFORMAÇÕES',
  },
  {
    id: 'c-voice-lounge',
    serverId: 's-dasideia',
    name: '🔊 Sala Principal',
    type: 'voice',
    category: 'VOICE CHANNELS',
  },
  {
    id: 'c-voice-devs',
    serverId: 's-dasideia',
    name: '🎮 Sala Dev & Pair',
    type: 'voice',
    category: 'VOICE CHANNELS',
  },

  // Rustaceans Brasil
  {
    id: 'c-rs-geral',
    serverId: 's-rustaceans',
    name: 'iniciantes',
    type: 'text',
    topic: 'Tire suas dúvidas sobre Ownership, Borrow Checker e Lifetimes',
    category: 'CANAIS RUST',
  },
  {
    id: 'c-rs-projetos',
    serverId: 's-rustaceans',
    name: 'showcase-projetos',
    type: 'text',
    topic: 'Compartilhe seus projetos feitos em Rust',
    category: 'CANAIS RUST',
  },
  {
    id: 'c-rs-voice',
    serverId: 's-rustaceans',
    name: '🔊 Papo Rustáceo',
    type: 'voice',
    category: 'VOICE CHANNELS',
  },

  // Tauri
  {
    id: 'c-tauri-general',
    serverId: 's-tauri',
    name: 'v2-discussion',
    type: 'text',
    topic: 'Tauri 2.0 release updates, plugins and mobile builds',
    category: 'COMMUNITY',
  },
  {
    id: 'c-tauri-voice',
    serverId: 's-tauri',
    name: '🔊 Office Hours',
    type: 'voice',
    category: 'VOICE CHANNELS',
  },

  // Gaming
  {
    id: 'c-gaming-chat',
    serverId: 's-gaming',
    name: 'lobby',
    type: 'text',
    topic: 'Bate-papo de jogos',
    category: 'GERAL',
  },
  {
    id: 'c-gaming-voice',
    serverId: 's-gaming',
    name: '🎮 Squad Discord',
    type: 'voice',
    category: 'VOICE CHANNELS',
  },
];

export const INITIAL_MESSAGES: Record<string, Message[]> = {
  'c-geral': [
    {
      id: 'm-1',
      channelId: 'c-geral',
      author: MOCK_USERS[1], // Ferris
      content: 'Bem-vindos ao **DasCord**! 🚀 Acabamos de subir o aplicativo rodando em **Tauri v2 + Rust**. O consumo de memória está surreal: apenas ~38MB de RAM contra quase 1GB do Discord oficial no Electron!',
      timestamp: 'Hoje às 19:40',
      reactions: [
        { emoji: '🔥', count: 4, active: true },
        { emoji: '🦀', count: 6, active: true },
        { emoji: '⚡', count: 3, active: false },
      ],
      attachments: [
        {
          type: 'code',
          title: 'src-tauri/src/lib.rs',
          language: 'rust',
          code: `#[tauri::command]\nfn get_system_stats() -> SystemStats {\n    SystemStats {\n        ram_usage_mb: 38.4,\n        engine: "Tauri v2 + Rust Native".into(),\n    }\n}`,
        },
      ],
    },
    {
      id: 'm-2',
      channelId: 'c-geral',
      author: MOCK_USERS[2], // DasCord Bot
      content: '🤖 **[Sistema]** Novo benchmark registrado: Tempo de inicialização a frio de **120ms**!',
      timestamp: 'Hoje às 19:42',
      reactions: [{ emoji: '🎉', count: 2, active: false }],
    },
    {
      id: 'm-3',
      channelId: 'c-geral',
      author: MOCK_USERS[3], // Ana
      content: 'Ficou incrivelmente rápido e a interface idêntica ao Discord! Testei o chat, a barra lateral e os canais de voz.',
      timestamp: 'Hoje às 19:43',
      reactions: [{ emoji: '❤️', count: 2, active: true }],
    },
  ],
  'c-rust-dev': [
    {
      id: 'm-4',
      channelId: 'c-rust-dev',
      author: MOCK_USERS[1],
      content: 'Aqui vamos coordenar a integração do hub de WebSockets usando Axum e Tokio no servidor.',
      timestamp: 'Hoje às 19:30',
      reactions: [{ emoji: '🚀', count: 3, active: true }],
    },
  ],
};

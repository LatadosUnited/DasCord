export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';

export interface User {
  id: string;
  name: string;
  tag: string;
  avatar: string;
  status: UserStatus;
  customStatus?: string;
  role: string;
  roleColor: string;
  isBot?: boolean;
}

export type ChannelType = 'text' | 'voice';

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  topic?: string;
  unread?: boolean;
  category: string;
}

export interface Reaction {
  emoji: string;
  count: number;
  active: boolean;
}

export interface Attachment {
  type: 'image' | 'code';
  url?: string;
  title?: string;
  language?: string;
  code?: string;
}

export interface Message {
  id: string;
  channelId: string;
  author: User;
  content: string;
  timestamp: string;
  reactions: Reaction[];
  attachments?: Attachment[];
  /** Momento de criação em ms; ausente nas mensagens de exemplo (mockData) */
  createdAt?: number;
  /** ID local da mensagem otimista que esta mensagem do servidor substitui */
  nonce?: string;
}

export interface Server {
  id: string;
  name: string;
  icon?: string;
  initials: string;
  gradient: string;
  unreadCount?: number;
  hasPing?: boolean;
}

export interface VoiceParticipant {
  id: string;
  name: string;
  avatar: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
}

export interface VoiceState {
  connected: boolean;
  channelId?: string;
  channelName?: string;
  serverName?: string;
  muted: boolean;
  deafened: boolean;
  screenShare: boolean;
  pingMs: number;
  participants: VoiceParticipant[];
}

export interface SystemStats {
  app_name: string;
  version: string;
  engine: string;
  ram_usage_mb: number;
  rust_version: string;
  ping_ms: number;
}

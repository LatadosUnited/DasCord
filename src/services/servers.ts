import { Channel, ChannelType, Server, User, VoiceParticipant } from '../types';
import { jsonBody, request } from './api';

/** Formato devolvido pela API */
export interface ServerDto {
  id: string;
  name: string;
  icon: string;
  ownerId: string | null;
  isDefault: boolean;
  memberCount: number;
  channels: Channel[];
}

export interface Invite {
  code: string;
  serverId: string;
  expiresAt: number | null;
  maxUses: number | null;
  uses: number;
  createdAt: number;
}

export const MIN_SERVER_NAME_CHARS = 2;
export const MAX_SERVER_NAME_CHARS = 100;

/** Opções de validade do convite, em segundos (null = nunca expira) */
export const INVITE_AGE_OPTIONS: { label: string; value: number | null }[] = [
  { label: '30 minutos', value: 30 * 60 },
  { label: '1 hora', value: 60 * 60 },
  { label: '6 horas', value: 6 * 60 * 60 },
  { label: '1 dia', value: 24 * 60 * 60 },
  { label: '7 dias', value: 7 * 24 * 60 * 60 },
  { label: 'Nunca', value: null },
];

export const INVITE_USES_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Sem limite', value: null },
  { label: '1 uso', value: 1 },
  { label: '5 usos', value: 5 },
  { label: '10 usos', value: 10 },
  { label: '25 usos', value: 25 },
  { label: '100 usos', value: 100 },
];

// Degradês da identidade Faísca; cada servidor sem ícone ganha um fixo, derivado do ID
const SERVER_GRADIENTS = [
  'linear-gradient(135deg, #ffb020 0%, #ff7a45 100%)',
  'linear-gradient(135deg, #ff7a45 0%, #c2410c 100%)',
  'linear-gradient(135deg, #9d8cf0 0%, #5b4bc4 100%)',
  'linear-gradient(135deg, #43c27f 0%, #1f7a4d 100%)',
  'linear-gradient(135deg, #7cc4ff 0%, #2f6fbf 100%)',
  'linear-gradient(135deg, #f0524f 0%, #a1283a 100%)',
];

function gradientFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SERVER_GRADIENTS[hash % SERVER_GRADIENTS.length];
}

/** "DasIdeia HQ" -> "DH"; "rustaceans" -> "RU" */
export function serverInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function toServer(dto: ServerDto): Server {
  return {
    id: dto.id,
    name: dto.name,
    icon: dto.icon || undefined,
    initials: serverInitials(dto.name),
    gradient: gradientFor(dto.id),
    ownerId: dto.ownerId,
    isDefault: dto.isDefault,
  };
}

/** Aceita o código puro ou um link que termina nele */
export function parseInviteCode(input: string): string {
  const last = input.trim().replace(/\/+$/, '').split('/').pop() ?? '';
  return last.trim();
}

export const apiListServers = () => request<{ servers: ServerDto[] }>('/api/servers');

export const apiCreateServer = (name: string) =>
  request<{ server: ServerDto }>('/api/servers', jsonBody('POST', { name }));

export const apiRenameServer = (serverId: string, name: string) =>
  request<{ server: ServerDto }>(`/api/servers/${encodeURIComponent(serverId)}`, jsonBody('PATCH', { name }));

export const apiUploadServerIcon = (serverId: string, file: File) =>
  request<{ server: ServerDto }>(`/api/servers/${encodeURIComponent(serverId)}/icon`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });

// ---------- Canais ----------

export const MAX_CHANNEL_NAME_CHARS = 60;
export const MAX_CHANNEL_TOPIC_CHARS = 300;

/** Espelha o servidor: canal de texto vira minúsculo e sem espaços */
export const channelSlug = (name: string) =>
  Array.from(name)
    .map((ch) => (/\p{L}|\p{N}/u.test(ch) ? ch.toLowerCase() : ' '))
    .join('')
    .trim()
    .replace(/\s+/g, '-');

export const apiCreateChannel = (serverId: string, name: string, type: ChannelType, category: string) =>
  request<{ server: ServerDto }>(
    `/api/servers/${encodeURIComponent(serverId)}/channels`,
    jsonBody('POST', { name, type, category })
  );

/** Só os campos enviados mudam */
export const apiUpdateChannel = (
  serverId: string,
  channelId: string,
  patch: { name?: string; topic?: string; category?: string }
) =>
  request<{ server: ServerDto }>(
    `/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}`,
    jsonBody('PATCH', patch)
  );

export const apiDeleteChannel = (serverId: string, channelId: string) =>
  request<{ server: ServerDto }>(
    `/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}`,
    { method: 'DELETE' }
  );

export const apiReorderChannels = (serverId: string, channelIds: string[]) =>
  request<{ server: ServerDto }>(
    `/api/servers/${encodeURIComponent(serverId)}/channels/order`,
    jsonBody('POST', { channelIds })
  );

export const apiDeleteServer = (serverId: string) =>
  request<{ success: boolean }>(`/api/servers/${encodeURIComponent(serverId)}`, { method: 'DELETE' });

export const apiLeaveServer = (serverId: string) =>
  request<{ success: boolean }>(`/api/servers/${encodeURIComponent(serverId)}/leave`, { method: 'POST' });

export const apiGetServerMembers = (serverId: string) =>
  request<{ members: User[] }>(`/api/servers/${encodeURIComponent(serverId)}/members`);

/** Quem está em cada canal de voz ocupado do servidor */
export const apiGetServerVoice = (serverId: string) =>
  request<{ channels: Record<string, Omit<VoiceParticipant, 'speaking'>[]> }>(
    `/api/servers/${encodeURIComponent(serverId)}/voice`
  );

export const apiCreateInvite =(serverId: string, maxAgeSeconds: number | null, maxUses: number | null) =>
  request<{ invite: Invite }>(
    `/api/servers/${encodeURIComponent(serverId)}/invites`,
    jsonBody('POST', { maxAgeSeconds, maxUses })
  );

export const apiAcceptInvite = (input: string) =>
  request<{ server: ServerDto; alreadyMember: boolean }>(
    `/api/invites/${encodeURIComponent(parseInviteCode(input))}/accept`,
    { method: 'POST' }
  );

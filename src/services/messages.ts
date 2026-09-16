import { Message, Reaction } from '../types';
import { API_URL } from './config';

/** Últimas mensagens salvas de um canal. Retorna null se o servidor estiver fora ou negar acesso. */
export async function apiGetChannelMessages(token: string, channelId: string): Promise<Message[] | null> {
  try {
    const res = await fetch(
      `${API_URL}/api/channels/${encodeURIComponent(channelId)}/messages?limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.messages as Message[]).map(withTimestamp);
  } catch {
    return null;
  }
}

export function formatMessageTime(ms: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return `Hoje às ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Ontem às ${time}`;
  return `${date.toLocaleDateString('pt-BR')} ${time}`;
}

/** Preenche o texto de horário das mensagens vindas do servidor */
export function withTimestamp(message: Message): Message {
  return message.createdAt !== undefined
    ? { ...message, timestamp: formatMessageTime(message.createdAt) }
    : message;
}

/**
 * Junta mensagens novas às existentes sem duplicar: mensagens do servidor substituem
 * a versão otimista local (pelo nonce) e a lista fica em ordem cronológica.
 */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const replacedNonces = new Set(incoming.map((m) => m.nonce).filter(Boolean));
  const byId = new Map<string, Message>();
  for (const m of existing) {
    if (!replacedNonces.has(m.id)) byId.set(m.id, m);
  }
  for (const m of incoming) {
    byId.set(m.id, m);
  }

  const all = Array.from(byId.values());
  return sortByTime(all);
}

/** Troca uma mensagem editada pela versão do servidor; ignora o que já não está na lista */
export function applyMessageUpdate(existing: Message[], updated: Message): Message[] {
  return existing.map((m) => (m.id === updated.id ? withTimestamp(updated) : m));
}

export function removeMessage(existing: Message[], messageId: string): Message[] {
  return existing.filter((m) => m.id !== messageId);
}

/** Lista nova de quem reagiu com um emoji; sem ninguém, a reação sai da mensagem */
export function applyReaction(
  existing: Message[],
  messageId: string,
  emoji: string,
  userIds: string[]
): Message[] {
  return existing.map((m) => {
    if (m.id !== messageId) return m;
    const others = m.reactions.filter((r) => r.emoji !== emoji);
    const reaction: Reaction = { emoji, userIds };
    // Emoji novo entra no fim, como no servidor; o que já existia mantém a posição
    const reactions = m.reactions.some((r) => r.emoji === emoji)
      ? m.reactions.map((r) => (r.emoji === emoji ? reaction : r))
      : [...others, reaction];
    return { ...m, reactions: reactions.filter((r) => r.userIds.length > 0) };
  });
}

function sortByTime(all: Message[]): Message[] {
  // Mensagens de exemplo não têm horário e ficam no topo, como antes
  const untimed = all.filter((m) => m.createdAt === undefined);
  const timed = all
    .filter((m) => m.createdAt !== undefined)
    .sort((a, b) => a.createdAt! - b.createdAt!);
  return [...untimed, ...timed];
}

import { UserStatus } from '../types';

export const STATUS_OPTIONS: { id: UserStatus; label: string; description?: string }[] = [
  { id: 'online', label: 'Disponível' },
  { id: 'idle', label: 'Ausente' },
  {
    id: 'dnd',
    label: 'Não perturbe',
    description: 'Você não receberá notificações na área de trabalho.',
  },
  {
    id: 'offline',
    label: 'Invisível',
    description: 'Você não aparecerá online, mas terá acesso completo ao DasCord.',
  },
];

export function statusLabel(status: UserStatus): string {
  return STATUS_OPTIONS.find((s) => s.id === status)?.label ?? 'Disponível';
}

export const MAX_CUSTOM_STATUS_CHARS = 128;
export const MAX_DISPLAY_NAME_CHARS = 32;

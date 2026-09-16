// Quem está na chamada, do jeito que a interface precisa ver. É só a lista e o
// aviso de mudança: como cada participante chegou ali (malha P2P ou SFU) é
// problema de quem usa.
import { VoiceParticipant } from '../types';
import { ParticipantsListener } from './voiceTypes';

/** Campos que mudam durante a chamada */
export type ParticipantChanges = Partial<Omit<VoiceParticipant, 'id'>>;

/**
 * Enfeita cada participante antes de entregá-lo à interface. A malha P2P usa
 * isso para dizer em que pé está a conexão com cada um; o SFU não precisa.
 */
type Decorator = (participant: VoiceParticipant) => VoiceParticipant;

export class ParticipantRoster {
  private participants: Map<string, VoiceParticipant> = new Map();
  private listeners: Set<ParticipantsListener> = new Set();

  constructor(private decorate: Decorator = (p) => ({ ...p })) {}

  /** Quem entra na chamada passa a receber a lista; o ouvinte anterior é esquecido */
  listen(cb: ParticipantsListener) {
    this.listeners.clear();
    this.listeners.add(cb);
  }

  clearListeners() {
    this.listeners.clear();
  }

  has(id: string): boolean {
    return this.participants.has(id);
  }

  isStreaming(id: string): boolean {
    return !!this.participants.get(id)?.streaming;
  }

  ids(): string[] {
    return Array.from(this.participants.keys());
  }

  isSpeaking(id: string): boolean {
    return !!this.participants.get(id)?.speaking;
  }

  /** Coloca ou substitui um participante e avisa a interface */
  upsert(participant: VoiceParticipant) {
    this.participants.set(participant.id, participant);
    this.notify();
  }

  /** Muda o que veio e avisa; um participante que não está na lista é ignorado */
  patch(id: string | undefined, changes: ParticipantChanges) {
    const participant = id ? this.participants.get(id) : undefined;
    if (!participant) return;
    Object.assign(participant, changes);
    this.notify();
  }

  /** Troca a lista inteira. O SFU faz assim: a sala é a fonte da verdade. */
  replace(participants: VoiceParticipant[]) {
    this.participants = new Map(participants.map((p) => [p.id, p]));
    this.notify();
  }

  /** Só quem está nesta lista aparece falando */
  setSpeaking(ids: Set<string>) {
    this.participants.forEach((participant, id) => {
      participant.speaking = ids.has(id);
    });
    this.notify();
  }

  remove(id: string) {
    this.participants.delete(id);
    this.notify();
  }

  /** Esvazia sem avisar: quem sai da chamada avisa uma vez só, no fim */
  clear() {
    this.participants.clear();
  }

  notify() {
    // Cópias: o React compara por referência
    const list = Array.from(this.participants.values(), this.decorate);
    this.listeners.forEach((cb) => cb(list));
  }
}

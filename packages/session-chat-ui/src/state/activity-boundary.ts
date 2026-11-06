import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { TranscriptTurn } from '../model';
import type { ViewState } from './view-state';
import { nativeMessageKey } from '@gugu/session-core/session-record/native-read';

const boundaries = new WeakMap<object, string | null>();

/** A different person's group message remains visible but cannot move the viewer's boundary. */
export function latestViewerInput(turns: readonly TranscriptTurn[], viewerId?: string, fallback: string | null = null): string | null {
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t];
    for (let i = turn.items.length - 1; i >= 0; i--) {
      const item = turn.items[i];
      if (item.kind !== 'message' || item.role !== 'user') continue;
      const delivery = readDeliveryEnvelope(item.text);
      if (!delivery && turn.initiator === 'user') return typeof item._meta?.guguClientMessageId === 'string' ? item._meta.guguClientMessageId : nativeMessageKey(item.id);
      const self = viewerId?.replace(/^user:/, '');
      const own = self && delivery?.segments.findLast(segment => segment.facts?.fromType === 'human' && segment.facts.fromId === `user:${self}`);
      if (own) return own.facts?.messageId ?? nativeMessageKey(item.id);
    }
  }
  return fallback;
}

/** Per conversation, including dispose/recreate. The initial mount never resets a saved reading state. */
export function resetActivityOnInput(model: object, input: string | null, view: ViewState): boolean {
  const known = boundaries.has(model), previous = boundaries.get(model);
  boundaries.set(model, input);
  if (!known || input === null || input === previous) return false;
  for (const key of Object.keys(view.snapshot())) if (key.startsWith('agent-activity:')) view.setCollapsed(key, false);
  return true;
}

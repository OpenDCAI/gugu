import type { PersonalConversationPreview } from '@gugu/session-core/session-record/personal-conversation';
import { nativeConversationActivity } from './session-conversation-activity';
import { publishConversationActivity } from './session-conversation-read';

type Preview = { text: string; at: string };
let owner: symbol | null = null;
const live = new Map<string, { preview: Preview; clearing?: true }>();

/** The list and its timestamp read the same projection, including an unfinished personal turn. */
export function nativeConversationListActivity(sessionId: string): Preview | null {
  const stored = nativeConversationActivity(sessionId);
  const current = live.get(sessionId)?.preview;
  return current && (!stored || current.at >= stored.at) ? current : stored;
}

/** One worker owns these temporary values. Late callbacks/cleanup cannot overwrite its successor. */
export function openNativeConversationPreviews(settled: (sessionId: string) => Promise<unknown>) {
  const token = Symbol('native-conversation-worker');
  owner = token;
  const reset = () => {
    if (owner !== token) return;
    const ids = [...live.keys()];
    live.clear();
    for (const id of ids) publishConversationActivity(id);
  };
  reset();
  return {
    async update(event: { sessionId: string; preview: PersonalConversationPreview | null }): Promise<void> {
      if (owner !== token) return;
      const previous = live.get(event.sessionId);
      if (event.preview) {
        const preview = { text: event.preview.text, at: new Date(event.preview.at).toISOString() };
        if (!previous?.clearing && previous?.preview.text === preview.text && previous.preview.at === preview.at) return;
        live.set(event.sessionId, { preview });
        publishConversationActivity(event.sessionId);
      } else if (previous) {
        // turnCommitted is emitted before the empty-active-turn snapshot. Keep the last visible reply
        // until that queued write settles; a new turn arriving meanwhile invalidates this cleanup.
        const pending = { preview: previous.preview, clearing: true as const };
        live.set(event.sessionId, pending);
        await settled(event.sessionId);
        if (owner !== token || live.get(event.sessionId) !== pending) return;
        live.delete(event.sessionId);
        publishConversationActivity(event.sessionId);
      }
    },
    reset,
    dispose() { reset(); if (owner === token) owner = null; },
  };
}

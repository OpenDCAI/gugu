/**
 * `[NO_REPLY]` — the silence marker an agent prints to decline a delivered turn.
 *
 * `<gugu_silence>` (apps/desktop/electron/product-platform-prompt.ts) teaches every agent this marker from
 * `NO_REPLY_MARKER` below, and promises "nothing is posted, nobody notified". Agent text never reaches a chat (replies go
 * through message_send), but two surfaces draw an agent's raw words back to people: the task panel (#4552) and the
 * group's running-bar preview card (#6357). Both ask this one question, so the promise holds the same on both.
 */

export const NO_REPLY_MARKER = '[NO_REPLY]';

/** The marker as agents actually emit it: bare, or fenced in inline code. Longest first, so a fence is taken whole. */
const FORMS = [`\`${NO_REPLY_MARKER}\``, NO_REPLY_MARKER] as const;

/**
 * Is this the whole of what the agent said — i.e. a declined turn? It is when the text is nothing but markers and
 * whitespace (agents repeat it, `[NO_REPLY][NO_REPLY]`, or pad it); any other word makes it a reply that is drawn.
 *
 * `streaming` also accepts a trailing *prefix* of the marker. Without it the marker types itself out one chunk at a
 * time and vanishes on commit — a flash is still something the reader saw.
 *
 * Empty text is deliberately NOT silence. An assistant message exists before its first chunk arrives, and
 * `pendingTurnHeader` reads that existence to decide the turn already has a voice — call the empty state silence and
 * the turn's live header misreads the turn for the whole time the agent is thinking.
 */
export function isGuguSilence(text: string, opts?: { streaming?: boolean }): boolean {
  let rest = text.trimStart();
  if (!rest) return false;
  for (;;) {
    const form = FORMS.find((candidate) => rest.startsWith(candidate));
    if (!form) break;
    rest = rest.slice(form.length).trimStart();
  }
  if (!rest) return true;
  return opts?.streaming === true && FORMS.some((form) => form.startsWith(rest));
}

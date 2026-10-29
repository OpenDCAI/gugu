import { messageQuoteText, readMessageQuote, type MessageQuoteSource } from '@gugu/core/shared/ui/messageQuote';

export type SessionQuoteDraft = Readonly<{ source: MessageQuoteSource; text: string; sender: string }>;
type State = { quote: SessionQuoteDraft | null; listeners: Set<() => void> };
const drafts = new WeakMap<object, State>();
function stateOf(owner: object): State {
  let state = drafts.get(owner);
  if (!state) { state = { quote: null, listeners: new Set() }; drafts.set(owner, state); }
  return state;
}

/** Composer-only state belongs to this store, including when its editor lives in a portal. */
export function getSessionQuote(owner: object): SessionQuoteDraft | null { return stateOf(owner).quote; }
export function subscribeSessionQuote(owner: object, listener: () => void): () => void {
  const state = stateOf(owner);
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}
export function setSessionQuote(owner: object, quote: SessionQuoteDraft | null): void {
  const state = stateOf(owner);
  if (state.quote === quote) return;
  state.quote = quote;
  state.listeners.forEach(listener => listener());
}
/** Finishing an older send must not erase a quote chosen while attachments were uploading. */
export function consumeSessionQuote(owner: object, sent: SessionQuoteDraft | null): void {
  if (getSessionQuote(owner) === sent) setSessionQuote(owner, null);
}
export function quotedSessionPrompt(text: string, quote: SessionQuoteDraft | null): string {
  return quote ? messageQuoteText(quote.source, quote.text, quote.sender) + text : text;
}
export function restoreSessionQuote(owner: object, text: string): string {
  const quote = readMessageQuote(text);
  setSessionQuote(owner, quote ? { source: quote.source, text: quote.excerpt, sender: quote.sender } : null);
  return quote?.body ?? text;
}

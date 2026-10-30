import type { TranscriptTurn } from '../acp/client';

/** Provider message identity survives the different live/history turn prefixes. Never match by text. */
export function nativeMessageKey(id: string): string {
  const key = id.split(':message:').at(-1)!;
  return /^(?:msg_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f-]{27,})$/i.test(key) ? key : id;
}
export function nativeReplyKeys(turn: TranscriptTurn): string[] {
  return turn.items.flatMap(item => item.kind === 'message' && item.role === 'assistant' && item.text.trim() && item.text.trim() !== '[NO_REPLY]'
    ? [item.id] : []);
}

export type NativeReadJournal = Record<string, { read: boolean; aliases: string[] }>;
export const unreadNativeMessages = (journal: NativeReadJournal): string[] => Object.keys(journal).filter(id => !journal[id]!.read);
export function nativeReadAliases(journal: NativeReadJournal): Record<string, string> {
  const values = new Map<string, string | null>();
  for (const [key, value] of Object.entries(journal)) for (const alias of value.aliases) {
    values.set(alias, values.has(alias) && values.get(alias) !== key ? null : key);
  }
  return Object.fromEntries([...values].filter((entry): entry is [string, string] => entry[1] !== null));
}
export function addNativeReplies(journal: NativeReadJournal, keys: readonly string[], aliases: ReadonlyMap<string, string> = new Map()): NativeReadJournal {
  const next = { ...journal };
  for (const key of keys) next[key] = next[key] ?? { read: false, aliases: [...new Set([key, nativeMessageKey(key), aliases.get(key) ?? key])] };
  return next;
}
export function seeNativeReplies(journal: NativeReadJournal, visible: readonly string[]): NativeReadJournal {
  const aliases = nativeReadAliases(journal);
  const seen = new Set(visible.map(id => Object.hasOwn(journal, id) ? id : aliases[nativeMessageKey(id)]).filter(Boolean));
  return Object.fromEntries(Object.entries(journal).map(([key, value]) => [key, { ...value, read: value.read || seen.has(key) }]));
}

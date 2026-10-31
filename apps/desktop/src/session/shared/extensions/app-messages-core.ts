import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { groupFileLink, parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import { personId, placeOf } from './app-runtime-protocol';

/**
 * `gugu.messages` (`chat:read`): an App reads a chat's messages — a stretch of its timeline or one thread (`history`), or the
 * ones holding a piece of text or naming a file (`search`). The same answer on the desktop (main) and the phone (the outer
 * gugu page); `chat:read` is asked at each host's door, from the verb's row.
 *
 * Read through the doors an agent's `message_history` / `message_search` take (`chat.message_history_as` /
 * `message_search_as`), as whoever reads — the person, or the agent a page or a program's call works for (`asAgent`, as
 * `gugu.files` reads). What they may see is judged there: a chat they are not in has no messages, whispers to others and
 * what came before they could see it are not there. ❌ No second filter here.
 */

export interface AppMessage {
  /** What `gugu.showMessage(id)` takes. */
  id: string;
  seq: number;
  chat: string;
  /** The thread's first message, when it is in one. */
  thread: string | null;
  /** Who wrote it; null for a line gugu wrote itself (someone joined: `contentType` 'system'). */
  sender: { id: string; name: string } | null;
  text: string;
  contentType: string;
  createdAt: string;
  /** Every file link in `text` (a pill, a link), read by the one reader of them (`parseGroupFileLink`). */
  refs: { file: string; version?: number; at?: Record<string, string> }[];
}

export interface AppMessagesPage {
  messages: AppMessage[];
  /** Pass it back as `before` for the page older than this one; null when there is none. */
  next: number | null;
}

const LIMIT_DEFAULT = 50;
// The doors answer at most 100 a call.
const LIMIT_MAX = 100;

const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid' as const });

interface MessageRow {
  id: string;
  seq: number;
  sender_user_id: string | null;
  sender_name: string;
  content: string | null;
  content_type: string;
  thread_root_id: string | null;
  created_at: string;
}

// A link ends where markdown or prose would end it: `groupFileLink` escapes all of these inside one.
const FILE_LINK = /gugu-file:\/\/[^\s()[\]<>"'`]+/gi;

function refsOf(text: string): AppMessage['refs'] {
  return [...text.matchAll(FILE_LINK)].flatMap(([href]) => {
    const link = parseGroupFileLink(href);
    if (!link) return [];
    return [{ file: link.itemId, ...(link.version === undefined ? {} : { version: link.version }), ...(link.at ? { at: { ...link.at } } : {}) }];
  });
}

/** The chat a call names (`{ chat }`), in its one spelling: `gugu.chats.members` takes it the same way. */
export function chatOf(args: Record<string, unknown>): string {
  if (typeof args.chat !== 'string' || !args.chat) throw invalid("Say which chat: { chat: id }, as getContext() or a file's entry gives it");
  return (placeOf({ chat: args.chat }) as { chat: string }).chat;
}

function pageOf(args: Record<string, unknown>): { p_before_seq: number | null; p_limit: number } {
  const { before, limit = LIMIT_DEFAULT } = args;
  if (before !== undefined && before !== null && !(Number.isInteger(before) && (before as number) > 0)) {
    throw invalid('before is the next a page gave back');
  }
  if (!(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= LIMIT_MAX)) throw invalid(`limit is a whole number from 1 to ${LIMIT_MAX}`);
  return { p_before_seq: (before as number | null | undefined) ?? null, p_limit: limit as number };
}

/** What `search` looks for: the text, or a file's link (its entry, or its id). */
function queryOf(args: Record<string, unknown>): string {
  const { query, file } = args;
  if ((query === undefined) === (file === undefined)) throw invalid('Say what to look for: { query } (a piece of text) or { file } (an entry or its id)');
  if (query !== undefined) {
    if (typeof query !== 'string' || !query.trim()) throw invalid('query is a piece of text');
    return query;
  }
  const id = typeof file === 'string' ? file : (file as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw invalid("file is a chat file's entry, or its id");
  return groupFileLink(id.toLowerCase());
}

export function createAppMessages(platform: { account(): Promise<{ token: string }> }) {
  async function read(name: string, args: Record<string, unknown>, chat: string, limit: number): Promise<AppMessagesPage> {
    const { token } = await platform.account();
    const { data, error } = await createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } }).rpc(name, args);
    if (error) throw Object.assign(new Error(error.message), { code: 'failed' as const });
    const rows = (data as MessageRow[] | null) ?? [];
    return {
      messages: rows.map((row) => ({
        id: row.id,
        seq: Number(row.seq),
        chat,
        thread: row.thread_root_id,
        sender: row.sender_user_id ? { id: personId(row.sender_user_id), name: row.sender_name } : null,
        text: row.content ?? '',
        contentType: row.content_type,
        createdAt: row.created_at,
        refs: refsOf(row.content ?? ''),
      })),
      next: rows.length === limit ? Number(rows[rows.length - 1]!.seq) : null,
    };
  }

  return {
    /** A chat's timeline, or one thread (`thread`: its first message), newest first. */
    async history(args: Record<string, unknown>, as: { asAgent?: string | null } = {}): Promise<AppMessagesPage> {
      const chat = chatOf(args);
      if (args.thread !== undefined && (typeof args.thread !== 'string' || !args.thread)) throw invalid("thread is the thread's first message's id");
      const page = pageOf(args);
      return read('message_history_as', { p_chat_id: chat, p_as_user_id: as.asAgent ?? null, p_thread_root_id: args.thread ?? null, ...page }, chat, page.p_limit);
    },
    /** A chat's messages, threads too, holding a piece of text or naming a file, newest first. */
    async search(args: Record<string, unknown>, as: { asAgent?: string | null } = {}): Promise<AppMessagesPage> {
      const chat = chatOf(args);
      const query = queryOf(args);
      const page = pageOf(args);
      return read('message_search_as', { p_chat_id: chat, p_query: query, p_as_user_id: as.asAgent ?? null, ...page }, chat, page.p_limit);
    },
  };
}

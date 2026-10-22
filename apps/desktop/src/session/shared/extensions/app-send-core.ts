import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { groupFileLink } from '@gugu/core/shared/ui/fileLink';
import { stringifyMention } from '@gugu/session-shared/markdown';
import { APP_COMPOSE_IMAGE_MAX_BYTES, APP_COMPOSE_MAX_IMAGES, fileRefOf, isLocal, type AppComposeDetail, type AppComposeImage, type AppComposeRef } from './app-runtime-protocol';

/**
 * `gugu.send(to, text, { chat } | { refs })` (摩擦单 F16, 真源 §4): an App tells an agent — or a person (F79) — that
 * something happened, in the name of whoever works the page, as a whisper in the chat the call names. (One of the
 * person's agents here is told another way, `gugu.messageAgent`: `extension-send.ts`.)
 * The same answer on the desktop (main, `extension-send.ts`) and the phone (the outer gugu page, `phoneAppHost.ts`):
 * only the account comes from the platform. `chat:relay` is asked at each host's door, from the verb's row.
 *
 * - Where: the chat the call names (真源原则 13 — never where the page is): `chat`, or the chat of the files its `refs`
 *   point at (App 引用 pill, owner 10-14: each a pill under the text). One of them.
 * - To whom: one other member of that chat — an agent or a person (F79) — `user:<uuid>` like every id an App sees (F35).
 *   The database judges a whisper (gugu-supabase #84); whoever it refuses is `not-found` (F78: the App drops them), with
 *   its words. Whoever receives it sees that this App sent it for the person (#6840).
 * - Written as the person (`sender_user_id`) — or as the person's own agent that works the page (owner 10-14), with the
 *   person's token, as the database lets them write for an agent of theirs in the chat (`chat.can_act_as`, gugu-supabase
 *   #116) — with `via_app` = the App: which App said it is a fact of the message, not a part of its text. The server
 *   limits it to 30 a minute per sender and App (`rate-limited`).
 */

export class AppSendError extends Error {
  constructor(
    readonly code: 'denied' | 'invalid' | 'not-found' | 'rate-limited' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

export interface AppSendPlatform {
  /** The signed-in person; throws `AppSendError('failed', …)` when there is none. */
  account(): Promise<{ token: string; userId: string }>;
}

const USER_ID = /^user:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function client(token: string, schema: 'chat' | 'identity') {
  return createGuguSupabaseClient({ schema, headers: { Authorization: `Bearer ${token}` } });
}

const named = (value: unknown) => value !== undefined && value !== null;

/** `about` was the one file a call was about; `refs` say that and where in it (owner 10-14: no second way kept). */
export const ABOUT_GONE = 'about is gone: name the file in refs — { refs: [{ file }] }, each { file, at?, label?, version? }';

/** At most this many pills in one call: each is a file read as the person. */
export const APP_REFS_MAX = 20;
/** A pill's words, the file's name and the App's label together, in characters as a person sees them: longer ones end in an ellipsis. */
const PILL_LABEL_MAX = 60;

/** One ref as the call gave it, checked: the file named as a call names any file (its entry, `ctx.file`, `{ id }`). */
interface CheckedRef {
  file: { id: string; chat?: string };
  /** The version the entry handed was listed at, when it is an entry. */
  entryVersion?: number;
  at?: Record<string, string>;
  label?: string;
  version?: number;
}

/**
 * A pill's words on one line (复核 51e9c2fa 要改 1): a line break in them ends the pill where it is written — the bubble
 * and the session page then show its raw text, and what follows the break reads as markdown blocks of its own.
 */
const oneLine = (words: string) => words.replace(/\s+/g, ' ').trim();

/**
 * `at`: where in the file, as the App names it — its own keys and values (`{ slide: 3, shape: 12 }`, `{ range: 'R&D!A1' }`).
 * The host writes it into the link and hands it back as it was (155 10-15): the App escapes nothing.
 */
function placeOf(at: unknown, index: number): Record<string, string> {
  const shape = `refs[${index}].at is where in the file: its keys and values, such as { slide: 3, shape: 12 }`;
  if (typeof at !== 'object' || at === null || Array.isArray(at)) throw new AppSendError('invalid', shape);
  const entries = Object.entries(at);
  if (entries.length === 0) throw new AppSendError('invalid', shape);
  return Object.fromEntries(entries.map(([key, value]) => {
    if (!key || !(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) throw new AppSendError('invalid', shape);
    return [key, String(value)];
  }));
}

function refsOf(refs: unknown): CheckedRef[] {
  if (!Array.isArray(refs) || refs.length === 0) throw new AppSendError('invalid', 'refs is a list of { file, at?, label?, version? }, at least one');
  if (refs.length > APP_REFS_MAX) throw new AppSendError('invalid', `At most ${APP_REFS_MAX} refs in one call`);
  return refs.map((ref, index) => {
    const { file, at, label, version } = (ref ?? {}) as { file?: unknown; at?: unknown; label?: unknown; version?: unknown };
    let place;
    try {
      place = fileRefOf(file);
    } catch (error) {
      throw new AppSendError('invalid', `refs[${index}].file: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isLocal(place) || !('id' in place) || !UUID.test(place.id)) {
      throw new AppSendError('invalid', `refs[${index}].file is a chat file: pass its entry or ctx.file`);
    }
    const where = at === undefined ? undefined : placeOf(at, index);
    if (label !== undefined && typeof label !== 'string') throw new AppSendError('invalid', `refs[${index}].label is what the pill says after the file's name, a string`);
    if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version) || version < 1)) {
      throw new AppSendError('invalid', `refs[${index}].version is the version the place was picked on, as the entry gave it`);
    }
    const entryVersion = (file as { version?: unknown }).version;
    return {
      file: place,
      ...(typeof entryVersion === 'number' && Number.isInteger(entryVersion) ? { entryVersion } : {}),
      ...(where === undefined ? {} : { at: where }),
      ...(label !== undefined && oneLine(label) ? { label: oneLine(label) } : {}),
      ...(version === undefined ? {} : { version }),
    };
  });
}

/**
 * The files `refs` point at, read as the person — files they can see, all in one chat — and each pill as a message
 * holds it: `@[<file> · <label>](gugu-file://<id>?v=<version>#<at>)`, the session page's @file mention pointing at a
 * group's file. The version is the one the place was picked on: the ref's, else the entry's, else the file's now —
 * never one the file has not reached. The file's name is the folder's (155 10-15: never a name the App hands over, which
 * could call a deck 工资表.xlsx).
 */
async function pillsOf(token: string, refs: CheckedRef[]): Promise<{ chatId: string; pills: AppComposeRef[] }> {
  const ids = [...new Set(refs.map((ref) => ref.file.id.toLowerCase()))];
  const { data, error } = await client(token, 'chat').from('workspace_items').select('id, chat_id, kind, filename, version').in('id', ids);
  if (error) throw new AppSendError('failed', error.message);
  const rows = new Map(((data as { id: string; chat_id: string; kind?: string; filename: string; version: number | null }[] | null) ?? []).map((row) => [row.id.toLowerCase(), row]));
  const pills = refs.map((ref) => {
    const row = rows.get(ref.file.id.toLowerCase());
    if (!row) throw new AppSendError('not-found', `No file ${ref.file.id} here`);
    // 子文件夹: a folder is listed and entered, never opened — a pill that opens it would open nothing.
    if (row.kind === 'folder') throw new AppSendError('invalid', `${row.filename} is a folder: a pill points at a file`);
    if (ref.file.chat !== undefined && row.chat_id !== ref.file.chat) {
      throw new AppSendError('invalid', `File ${ref.file.id} is in chat ${row.chat_id}, not ${ref.file.chat}: pass the entry or ctx.file as it is`);
    }
    const version = ref.version ?? ref.entryVersion ?? row.version;
    if (version != null && row.version != null && version > row.version) {
      throw new AppSendError('invalid', `File ${ref.file.id} is at version ${row.version}: a place cannot be picked on version ${version}`);
    }
    const words = [oneLine(row.filename), ref.label].filter(Boolean).join(' · ');
    return { chatId: row.chat_id, label: clipped(words), link: groupFileLink(row.id, { version, at: ref.at }) };
  });
  const chats = new Set(pills.map((pill) => pill.chatId));
  if (chats.size > 1) throw new AppSendError('invalid', `refs point at files of ${chats.size} chats: one message is in one chat`);
  return { chatId: pills[0]!.chatId, pills: pills.map(({ label, link }) => ({ label, link })) };
}

/** Cut between characters as a person sees them (a flag, a family emoji stays whole), not between code points. */
function clipped(words: string): string {
  const chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(words)].map((part) => part.segment);
  return chars.length > PILL_LABEL_MAX ? `${chars.slice(0, PILL_LABEL_MAX - 1).join('')}…` : words;
}

/** A pill as a message's text holds it — what the chat bubble and the session page both draw as a pill (commit 2). */
export function pillText(pill: AppComposeRef): string {
  return stringifyMention({ label: pill.label, target: pill.link, kind: 'file' });
}

/** Said where a call names two places (`compose` names a session too, on the desktop). */
export const COMPOSE_WHERE = 'Say where: gugu.compose(text, { chat: id }), { session: id } or { refs: [{ file }] } — one of them, or none to let the person pick';

/** Where a compose goes, as a call names it: what the person picked when the call named none, and what the App hears back. */
export type ComposePlace = { chat: string } | { session: string };

/** What the host's sheet offers (`ComposeTargetPicker`): this computer's tasks too, or chats only; `current` comes ticked. */
export interface ComposePickAsk {
  tasks: boolean;
  current: string | null;
}

/** Whether the call named where it goes. Naming none is a call of its own: the person picks (`pickComposePlace`). */
export function composeNamesPlace(args: { chat?: unknown; session?: unknown; refs?: unknown }): boolean {
  return named(args.chat) || named(args.session) || named(args.refs);
}

/**
 * `gugu.compose(text)` naming no place: the host asks the person where, in its own sheet — the list is never the App's —
 * and it goes there as if the call had named it. The App hears the place, or that they cancelled. Images go into a
 * chat's composer only, so with images the sheet offers chats.
 */
export async function pickComposePlace(
  args: { text?: unknown; about?: unknown; images?: unknown },
  pick: (ask: { tasks: boolean }) => Promise<ComposePlace | null>,
): Promise<ComposePlace | { cancelled: true }> {
  if (named(args.about)) throw new AppSendError('invalid', ABOUT_GONE);
  if (!String(args.text ?? '').trim()) throw new AppSendError('invalid', 'Nothing to compose: text is empty');
  return (await pick({ tasks: !named(args.images) })) ?? { cancelled: true };
}

/**
 * `gugu.compose(text, { chat } | { refs })` into a chat the call names (a session's is the desktop's: `extension-send.ts`):
 * which chat, and what goes in its composer — the text as the App wrote it, with a new line for what the person adds,
 * and the pills its `refs` make beside it (the composer holds them; they go under what is sent). With refs, the text may
 * be empty. Nothing is sent here, so nothing more is asked: the person sends it, or not.
 */
export async function composeInChat(
  platform: Pick<AppSendPlatform, 'account'>,
  args: { text: unknown; chat?: unknown; refs?: unknown; about?: unknown; images?: unknown },
): Promise<AppComposeDetail> {
  if (named(args.about)) throw new AppSendError('invalid', ABOUT_GONE);
  const text = String(args.text ?? '').trim();
  if (!text && !named(args.refs)) throw new AppSendError('invalid', 'Nothing to compose: text is empty');
  const images = composeImagesOf(args.images);
  const placed = await composePlace(platform, text, args);
  return images.length > 0 ? { ...placed, images } : placed;
}

/** G3 The images a compose carries: checked here, once, for the desktop and the phone alike. */
export function composeImagesOf(images: unknown): AppComposeImage[] {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new AppSendError('invalid', 'images is a list of images (Blobs)');
  if (images.length > APP_COMPOSE_MAX_IMAGES) throw new AppSendError('invalid', `At most ${APP_COMPOSE_MAX_IMAGES} images in one compose`);
  return images.map((image, index) => {
    const { name, type, bytes } = (image ?? {}) as Partial<AppComposeImage>;
    if (!(bytes instanceof ArrayBuffer) || typeof type !== 'string' || !/^image\//i.test(type)) {
      throw new AppSendError('invalid', `images[${index}] is not an image: pass a Blob or File whose type is image/*`);
    }
    if (bytes.byteLength > APP_COMPOSE_IMAGE_MAX_BYTES) {
      throw new AppSendError('invalid', `images[${index}] is over the ${APP_COMPOSE_IMAGE_MAX_BYTES / 1024 / 1024} MiB a chat attachment may be`);
    }
    return { name: typeof name === 'string' && name.trim() ? name.trim() : `image-${index + 1}.${type.split('/')[1]?.split(/[+;]/)[0] || 'png'}`, type, bytes };
  });
}

async function composePlace(
  platform: Pick<AppSendPlatform, 'account'>,
  text: string,
  args: { chat?: unknown; refs?: unknown },
): Promise<{ chatId: string; text: string; refs?: AppComposeRef[] }> {
  if (named(args.chat) === named(args.refs)) throw new AppSendError('invalid', COMPOSE_WHERE);
  const refs = named(args.refs) ? refsOf(args.refs) : null;
  const { token } = await platform.account();
  const said = text ? `${text}\n` : '';
  if (refs) {
    const { chatId, pills } = await pillsOf(token, refs);
    return { chatId, text: said, refs: pills };
  }
  if (typeof args.chat !== 'string' || !UUID.test(args.chat)) throw new AppSendError('invalid', 'chat is a chat\'s id, as getContext() gives it');
  // A chat the person is not in has no composer of theirs: said to the App, not opened into nothing.
  const { data, error } = await client(token, 'chat').from('chats').select('id').eq('id', args.chat).maybeSingle();
  if (error) throw new AppSendError('failed', error.message);
  if (!data) throw new AppSendError('not-found', `No chat ${args.chat} you are in`);
  return { chatId: args.chat, text: said };
}

export function createAppSend(platform: AppSendPlatform) {
  /** `as`: the agent that works the page (its bare uuid), when an agent does. */
  return async function sendFromApp(
    extensionId: string,
    args: { to: unknown; text: unknown; chat?: unknown; refs?: unknown; about?: unknown },
    options: { as?: string } = {},
  ): Promise<{ id: string }> {
    if (named(args.about)) throw new AppSendError('invalid', ABOUT_GONE);
    if (named(args.chat) === named(args.refs)) {
      throw new AppSendError('invalid', 'Say where: gugu.send(to, text, { chat: id }) or { refs: [{ file }] } (its entry, or ctx.file) — one of them');
    }
    if (named(args.chat) && (typeof args.chat !== 'string' || !UUID.test(args.chat))) {
      throw new AppSendError('invalid', 'chat is a chat\'s id, as getContext() gives it');
    }
    const refs = named(args.refs) ? refsOf(args.refs) : null;
    const to = String(args.to ?? '');
    const toId = USER_ID.exec(to)?.[1];
    if (!toId) throw new AppSendError('invalid', 'to is a member\'s id, user:<uuid> — as members and presence give it');
    const text = String(args.text ?? '').trim();
    if (!text && !refs) throw new AppSendError('invalid', 'Say something: text is empty');

    const { token, userId } = await platform.account();
    const pointed = refs ? await pillsOf(token, refs) : null;
    const chatId = pointed ? pointed.chatId : (args.chat as string);

    const content = pointed ? [text, pointed.pills.map(pillText).join(' ')].filter(Boolean).join('\n\n') : text;
    const id = globalThis.crypto.randomUUID();
    const { error } = await client(token, 'chat').rpc('send_message_idempotent', {
      p_message_id: id,
      p_chat_id: chatId,
      p_sender_user_id: options.as ?? userId,
      p_to_user_ids: [toId],
      p_content: content,
      p_content_type: 'text',
      p_reply_to_message_id: null,
      p_thread_root_id: null,
      p_is_thread_root: false,
      p_is_whisper: true,
      p_via_app: extensionId,
    });
    if (error) {
      if (error.code === 'PT429' || /rate-limited/.test(error.message)) throw new AppSendError('rate-limited', error.message);
      // check_violation: the whisper rule (#84) refused `to` — the App drops them (F78); the database's words say why.
      if (error.code === '23514') throw new AppSendError('not-found', error.message);
      throw new AppSendError('failed', error.message);
    }
    return { id };
  };
}

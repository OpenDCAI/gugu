import type { AppSpawnAction } from '@gugu/session-core/session-record/contract';
import type { ExtensionCapability } from './manifest';
import { decodeTypedId } from '@gugu/core/shared/typedId.mjs';

/**
 * `gugu.dispatch(text, options)` (15): the one way an App hands something to someone — owner 10-25「全部统一」. Before it there
 * were four (compose, send, messageAgent, spawnAgent), each with its own words, capability and phone support, and three
 * stances on who picks the target. Now one verb, one target, one answer; underneath, the deliveries that were already
 * there (`app-send-core.ts`, `extension-send.ts`):
 * - `{ chat, member }`: a member of a chat, as `message_send` tells one — a whisper, or with `visible` a message the chat sees;
 * - `{ agent }`: one of the person's agents, as `session_message` tells one;
 * - `{ new: true }`: a new agent, its first words the text;
 * - `{ chat }` with `draft`: only into that chat's composer (as `draft` into an agent's): the person sends it, or not.
 * No `to`: the person picks in the host's sheet (`DispatchSheet`), seeing the whole text, every pill and the target, and
 * only their press sends — so that call needs no capability, only their gesture (as compose's and forum.assign's did).
 */

export type DispatchTarget = { chat: string } | { chat: string; member: string } | { agent: string } | { new: true };

/** What the sheet offers, when the call does not say (`offer`): the rows it shows. */
export const DISPATCH_OFFERS = ['chat', 'agent-in-chat', 'person-in-chat', 'my-agent', 'new-agent'] as const;
export type DispatchOffer = (typeof DISPATCH_OFFERS)[number];

const named = (value: unknown) => value !== undefined && value !== null;
const USER_ID = /^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Plain coded errors, as bridge-protocol's: this module is read by every host's door (the verb's row), so it carries no client.
const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'invalid' as const });
};

/** The calls of before 15, each said where it is now — what an App still calling one is told. */
export const DISPATCH_GONE = {
  compose: 'gugu.compose is gone (apiVersion 15): gugu.dispatch(text, { draft: true, to? | refs? })',
  send: 'gugu.send is gone (apiVersion 15): gugu.dispatch(text, { to: { chat, member } })',
  messageAgent: 'gugu.messageAgent is gone (apiVersion 15): gugu.dispatch(text, { to: { agent } })',
  spawnAgent: 'gugu.spawnAgent is gone (apiVersion 15): gugu.dispatch(prompt, { to: { new: true }, spawn })',
} as const;

/** The target the call names, checked; absent: the person picks. */
export function dispatchTargetOf(to: unknown): DispatchTarget | null {
  if (!named(to)) return null;
  const shape = 'to is { chat }, { chat, member }, { agent } or { new: true }';
  if (typeof to !== 'object' || Array.isArray(to)) return invalid(shape);
  const { chat, member, agent } = to as { chat?: unknown; member?: unknown; agent?: unknown; new?: unknown };
  if ((to as { new?: unknown }).new === true) return Object.keys(to).length === 1 ? { new: true } : invalid(shape);
  if (named(agent)) {
    if (typeof agent !== 'string' || !USER_ID.test(agent)) return invalid("to.agent is an agent's id, user:<uuid>");
    return named(chat) || named(member) ? invalid(shape) : { agent };
  }
  if (typeof chat !== 'string' || !UUID.test(chat)) return invalid("to.chat is a chat's id, as getContext() gives it");
  if (!named(member)) return { chat };
  if (typeof member !== 'string' || !USER_ID.test(member)) return invalid("to.member is a member's id, user:<uuid> — as chat.members gives it");
  return { chat, member };
}

/**
 * The capability a call needs (its `BRIDGE_VERBS` row): none when the person picks or only a draft is put down — the last
 * step is theirs — else the one the named target's delivery always needed. A bad `to` needs none: the call says what is wrong.
 */
export function dispatchNeeds(args: { to?: unknown; draft?: unknown; spawn?: unknown }): ExtensionCapability | null {
  if (args.draft === true || !named(args.to) || typeof args.to !== 'object') return null;
  const to = args.to as { member?: unknown; agent?: unknown; new?: unknown };
  if (named(to.member)) return 'chat:relay';
  if (to.new === true && named((args.spawn as { device?: unknown } | null)?.device)) return 'agents:control:all-machines';
  if (named(to.agent) || to.new === true) return 'agents:control';
  return null;
}

/** Only inside the person's gesture: the sheet (no `to`), and a draft into a composer — a page cannot fill one on its own. */
export function dispatchNeedsGesture(args: { to?: unknown; draft?: unknown }): boolean {
  return args.draft === true || !named(args.to);
}

/** The options as the call gave them, checked against its target: what goes with which target, said where it does not. */
export interface DispatchCall {
  text: string;
  draft: boolean;
  to: DispatchTarget | null;
  refs: unknown;
  images: unknown;
  visible: boolean;
  delivery?: 'queue' | 'defer';
  key?: string;
  spawn: DispatchSpawn;
  offers: readonly DispatchOffer[] | null;
}

export function dispatchCallOf(args: Record<string, unknown>): DispatchCall {
  if (named(args.about)) invalid('about is gone: name the file in refs — { refs: [{ file }] }');
  const text = String(args.text ?? '').trim();
  const draft = args.draft === true;
  if (named(args.draft) && typeof args.draft !== 'boolean') invalid('draft is true, or absent');
  const to = dispatchTargetOf(args.to);
  if (!text && !named(args.refs)) invalid('Say something: text is empty');
  if (named(args.images) && !draft) invalid('images go only into a chat\'s composer: { draft: true }');
  if (draft && to && ('member' in to || 'new' in to)) invalid('A draft goes into a composer: to { chat } or { agent }');
  if (!draft && to && !('member' in to) && !('agent' in to) && !('new' in to)) invalid('A chat as such is told nothing: to { chat, member }, or { draft: true }');
  if (named(args.visible) && args.visible !== true) invalid('visible is true, or absent');
  if (args.visible === true && (draft || (to && !('member' in to)))) invalid('visible is for a member of a chat: to { chat, member }');
  if (named(args.delivery) && args.delivery !== 'queue' && args.delivery !== 'defer') invalid("delivery is 'queue' or 'defer'");
  if (named(args.key) && (typeof args.key !== 'string' || !args.key)) invalid('key is a non-empty string');
  if ((named(args.delivery) || named(args.key)) && (draft || (to && !('agent' in to)))) invalid('delivery and key are for one of your agents: to { agent }');
  if (named(args.spawn) && (draft || (to && !('new' in to)))) invalid('spawn is for a new agent: to { new: true }');
  const spawn = spawnOf(args.spawn);
  let offers: DispatchOffer[] | null = null;
  if (named(args.offer)) {
    if (!Array.isArray(args.offer) || args.offer.length === 0 || args.offer.some((kind) => !DISPATCH_OFFERS.includes(kind as DispatchOffer))) {
      invalid(`offer is a list of ${DISPATCH_OFFERS.join(', ')}`);
    }
    if (to) invalid('offer is what the sheet shows: only without to');
    offers = args.offer as DispatchOffer[];
  }
  return {
    text,
    draft,
    to,
    refs: args.refs,
    images: args.images,
    visible: args.visible === true,
    ...(args.delivery === 'queue' || args.delivery === 'defer' ? { delivery: args.delivery } : {}),
    ...(typeof args.key === 'string' ? { key: args.key } : {}),
    spawn,
    offers,
  };
}

/** The words a new agent is started on (`session_spawn`'s), each said wrong where it is: never a field quietly dropped. */
export type DispatchSpawn = AppSpawnAction['spawn'];

function spawnOf(spawn: unknown): DispatchSpawn {
  if (!named(spawn)) return {};
  const shape = 'spawn is { title?, harness?, model?, transport?, project?, chat?, device? }';
  if (typeof spawn !== 'object' || Array.isArray(spawn)) return invalid(shape);
  const out: DispatchSpawn = {};
  for (const [key, value] of Object.entries(spawn as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (key === 'device') {
      try { decodeTypedId('device', value, 'spawn.device'); } catch (error) { invalid(error instanceof Error ? error.message : String(error)); }
      out.device = value as string;
    } else if (key === 'transport') {
      if (value !== 'acp' && value !== 'pty') invalid('spawn.transport is "acp" (a chat UI session) or "pty" (a terminal session)');
      out.transport = value as 'acp' | 'pty';
    } else if (key === 'chat') {
      if (typeof value !== 'string' || !UUID.test(value)) invalid("spawn.chat is a chat's id, a string as getContext() gives it");
      out.chat = value as string;
    } else if (key === 'title' || key === 'harness' || key === 'model' || key === 'project') {
      if (typeof value !== 'string' || !value.trim()) invalid(`spawn.${key} is a non-empty string`);
      out[key] = value as string;
    } else invalid(`${shape}: no ${key}`);
  }
  return out;
}

/**
 * What the sheet shows when the call does not say: a draft goes into a chat's or an agent's composer; a message to the
 * chat's agents and people (when the page is in a chat), the person's agents, or a new one. A host offers what it has.
 */
export function dispatchOffers(call: Pick<DispatchCall, 'draft' | 'offers' | 'images'>, host: { inChat: boolean; agents: boolean }): DispatchOffer[] {
  const wanted = call.offers ?? (call.draft ? ['chat', 'my-agent'] : ['agent-in-chat', 'person-in-chat', 'my-agent', 'new-agent']);
  return wanted.filter((kind) => {
    switch (kind) {
      case 'chat':
        return call.draft;
      case 'my-agent':
        // A session's composer takes words only: images go into a chat's.
        return host.agents && !(call.draft && named(call.images));
      case 'agent-in-chat':
      case 'person-in-chat':
        return !call.draft && host.inChat;
      case 'new-agent':
        return !call.draft && host.agents;
    }
  });
}

/** What the host's sheet is asked: what will go, and which rows to show. */
export interface DispatchAsk {
  draft: boolean;
  offers: DispatchOffer[];
  /** The text, and each pill as it will read (`file · label`). */
  text: string;
  pills: string[];
  /** The chat the page is drawn for, and who is in it: the rows of `agent-in-chat` / `person-in-chat`. */
  chat: { id: string; name: string; members: { id: string; name: string; kind: 'human' | 'agent'; avatar?: string }[] } | null;
  /** The agent ticked to begin with and listed first among the person's: the page's own session's, or the one the call names. */
  preselect: string | null;
  /** For a draft: the person's agents with a session on this computer — the only composers a draft can go into. */
  local?: string[];
  visible: boolean;
  /** Phone only: the default computer for a new agent; the person can change it in the existing machine picker. */
  spawnOn?: string | null;
  /**
   * Not a message but a forum assignment (`gugu.forum.assign`): the post's title is what is shown, read only, and only the
   * person's own agents are offered; what follows the pick is the forum's (`forum_assign`), not a delivery.
   */
  assign?: { title: string };
}

/**
 * What the person picked, and the text as they left it (the sheet lets them change it before it goes: it goes as theirs).
 * An agent of theirs is named by its id, wherever it runs.
 */
export type DispatchPicked =
  | { to: { chat: string } | { chat: string; member: string } | { agent: string } | { new: true; device?: string }; visible: boolean; text: string }
  | null;

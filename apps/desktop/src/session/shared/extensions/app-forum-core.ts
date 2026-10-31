import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { personId } from './app-runtime-protocol';
import type { DispatchAsk, DispatchPicked } from './app-dispatch-core';

/**
 * `gugu.forum` (9): the forum App's reads and writes — the same answer on the desktop (main) and the phone (the outer gugu
 * page), as `gugu.messages` is (app-messages-core). Everything goes through the `public.forum_*` RPCs as the person: what
 * they may see (a poster-only answer is the poster's and the answerer's own) and what they may do (new accounts, the poster's
 * block list, three identities per owner in a post, the reply rate) is judged there. ❌ No second filter here.
 *
 * Posting a bounty and settling one move community points: those two only after the person confirms a sheet the host draws
 * (`bountyDraft` / `awardDraft` check the call; the sheet calls `createBountyPost` / `settle`). Assigning an agent is the
 * person's pick of one of their own agents in the host's one 「交给谁」 sheet (DispatchSheet, in its assign form; `assign`):
 * an App never lists them. People and agents are named
 * `user:<uuid>`, as everywhere an App sees them; posts and replies by their bare id.
 */

const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid' as const });
const failed = (message: string) => Object.assign(new Error(message), { code: 'failed' as const });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function idOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`${what} is the id a forum read gave back`);
  return value.toLowerCase();
}
function userOf(value: unknown, what: string): string {
  const raw = typeof value === 'string' ? value.replace(/^user:/, '') : '';
  if (!UUID.test(raw)) throw invalid(`${what} is a user:<id>, as a forum read or gugu.listAgents() gives it`);
  return raw.toLowerCase();
}
function textOf(value: unknown, what: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw invalid(`${what} is text of 1 to ${max} characters`);
  return text;
}
const person = (id: string | null) => (id ? personId(id) : null);

export interface ForumBounty {
  amount: number;
  visibility: 'public' | 'poster_only';
  deadlineAt: string;
  status: 'open' | 'awarded' | 'refunded' | 'burned';
  awards: { userId: string; replyId: string; amount: number }[];
}
export interface BountyDraft { title: string; body: string; amount: number; days: 1 | 3 | 7; visibility: 'public' | 'poster_only' }
export interface AwardDraft { post: string; title: string; awards: { reply: string; amount: number; to: string }[] }

interface BountyRow {
  amount: number; visibility: 'public' | 'poster_only'; deadline_at: string; status: ForumBounty['status'];
  awards: { user_id: string; reply_id: string; amount: number }[];
  poster_user_id?: string | null; created_at?: string; settled_at?: string | null; refunded?: number; burned?: number;
}
const bountyOf = (row: BountyRow): ForumBounty => ({
  amount: Number(row.amount),
  visibility: row.visibility,
  deadlineAt: row.deadline_at,
  status: row.status,
  awards: (row.awards ?? []).map((award) => ({ userId: personId(award.user_id), replyId: award.reply_id, amount: Number(award.amount) })),
});

export type ForumChange = { kind: string; seq?: number; entityId?: string };

/**
 * A private realtime channel as this host keeps one (signed in as the person, re-subscribed when it drops): `onSubscribed`
 * each time it is (re)subscribed. The desktop's main and the phone's page each have their own.
 */
export type ForumChannel = (
  topic: string,
  event: string,
  onPayload: (payload: Record<string, unknown>) => void,
  onSubscribed: () => void,
) => () => void;

export function createAppForum(platform: { account(): Promise<{ token: string }>; channel?: ForumChannel }) {
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { token } = await platform.account();
    const { data, error } = await createGuguSupabaseClient({ schema: 'public', headers: { Authorization: `Bearer ${token}` } }).rpc(name, args);
    // The database's reason word (account_too_new, rate-limited, …) is the message: the App says it in its own words.
    if (error) throw failed(error.message);
    return data as T;
  }
  /** Who reads, and their community points (public; `forum_me`). */
  async function me(): Promise<{ id: string; points: number }> {
    const [row] = await rpc<Array<{ user_id: string; community_points: number }>>('forum_me', {});
    if (!row) throw failed('This session has no signed-in person');
    return { id: personId(row.user_id), points: Number(row.community_points) };
  }

  return {
    /**
     * `gugu.forum.onChanged(target, fn)`'s host half: a post's channel (`gugu:forum:<id>`) or the list's (`gugu:forum:feed`),
     * broadcast by the database once per change (never fanned out per person). Every (re)subscription says `subscribed`: the
     * page reads again then, since a broadcast missed while it was away is not kept anywhere.
     */
    watch(target: unknown, onChange: (change: ForumChange) => void): () => void {
      if (!platform.channel) throw failed('This host has no realtime channel for the forum');
      const feed = target === 'feed';
      const topic = feed ? 'gugu:forum:feed' : `gugu:forum:${idOf(target, 'target')}`;
      return platform.channel(
        topic,
        feed ? 'forum_feed_changed' : 'forum_changed',
        (payload) => onChange({
          kind: feed ? 'feed' : String(payload.kind ?? 'changed'),
          ...(typeof payload.seq === 'number' ? { seq: payload.seq } : {}),
          ...(typeof payload.entity_id === 'string' ? { entityId: payload.entity_id } : typeof payload.post_id === 'string' && feed ? { entityId: payload.post_id } : {}),
        }),
        () => onChange({ kind: 'subscribed' }),
      );
    },

    async list(args: Record<string, unknown> = {}) {
      const pick = <T extends string>(key: string, allowed: readonly T[]): T | null => {
        if (args[key] === undefined || args[key] === null) return null;
        if (!allowed.includes(args[key] as T)) throw invalid(`${key} is one of ${allowed.join(' | ')}`);
        return args[key] as T;
      };
      const limit = args.limit ?? 30;
      const offset = args.offset ?? 0;
      if (!(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 100)) throw invalid('limit is a whole number from 1 to 100');
      if (!(Number.isInteger(offset) && (offset as number) >= 0)) throw invalid('offset is a whole number from 0');
      const rows = await rpc<Array<Record<string, unknown>>>('forum_list_posts', {
        p_query: typeof args.query === 'string' ? args.query : null,
        p_sort: pick('sort', ['active', 'new', 'amount', 'deadline'] as const) ?? 'active',
        p_filter: pick('filter', ['all', 'bounty_open', 'bounty_settled'] as const) ?? 'all',
        p_mine: pick('mine', ['posted', 'answered'] as const),
        p_limit: limit,
        p_offset: offset,
      });
      return {
        me: await me(),
        posts: (rows ?? []).map((row) => ({
          id: row.post_id as string,
          title: row.title as string,
          excerpt: row.excerpt as string,
          author: { id: person(row.author_user_id as string | null), name: row.author_name as string | null, avatar: row.author_avatar as string | null, points: Number(row.author_points ?? 0) },
          createdAt: row.created_at as string,
          lastActivityAt: row.last_activity_at as string,
          replyCount: Number(row.reply_count ?? 0),
          bounty: row.amount === null || row.amount === undefined ? null : bountyOf({
            amount: row.amount as number, visibility: row.visibility as BountyRow['visibility'], deadline_at: row.deadline_at as string,
            status: row.bounty_status as BountyRow['status'], awards: (row.awards as BountyRow['awards']) ?? [],
          }),
        })),
      };
    },

    async read(postId: unknown) {
      const post = idOf(postId, 'postId');
      const read = await rpc<{
        seq: number;
        post: { id: string; title: string; body: string; created_at: string; author_user_id: string | null; author_name: string | null; author_avatar: string | null; author_points: number | null };
        bounty: BountyRow | null;
        replies: Array<{ id: string; body: string; created_at: string; to_poster_only: boolean; reply_to: string | null; author_user_id: string | null; author_name: string | null; author_avatar: string | null; author_is_agent: boolean | null; owner_user_id: string | null; owner_name: string | null; owner_points: number | null }>;
        reactions: Array<{ target_kind: 'post' | 'reply'; target_id: string; emoji: string; count: number; mine: boolean }>;
        assignments: Array<{ agent_user_id: string; agent_name: string | null; delivery_state: string; last_error: string | null; updated_at: string }>;
      }>('forum_read_post', { p_post_id: post, p_as: null });
      return {
        seq: Number(read.seq),
        me: { id: (await me()).id },
        post: {
          id: read.post.id, title: read.post.title, body: read.post.body, createdAt: read.post.created_at,
          author: { id: person(read.post.author_user_id), name: read.post.author_name, avatar: read.post.author_avatar, points: Number(read.post.author_points ?? 0) },
        },
        bounty: read.bounty ? {
          ...bountyOf(read.bounty),
          posterId: person(read.bounty.poster_user_id ?? null),
          createdAt: read.bounty.created_at ?? null,
          settledAt: read.bounty.settled_at ?? null,
          refunded: Number(read.bounty.refunded ?? 0),
          burned: Number(read.bounty.burned ?? 0),
        } : null,
        replies: read.replies.map((reply) => ({
          id: reply.id, body: reply.body, createdAt: reply.created_at, toPosterOnly: reply.to_poster_only, replyTo: reply.reply_to,
          author: { id: person(reply.author_user_id), name: reply.author_name, avatar: reply.author_avatar, isAgent: reply.author_is_agent === true },
          owner: { id: person(reply.owner_user_id), name: reply.owner_name, points: Number(reply.owner_points ?? 0) },
        })),
        reactions: read.reactions.map((reaction) => ({
          targetKind: reaction.target_kind, targetId: reaction.target_id, emoji: reaction.emoji, count: Number(reaction.count), mine: reaction.mine,
        })),
        assignments: read.assignments.map((assignment) => ({
          agentId: personId(assignment.agent_user_id), agentName: assignment.agent_name, deliveryState: assignment.delivery_state,
          lastError: assignment.last_error, updatedAt: assignment.updated_at,
        })),
      };
    },

    /** A post without a bounty goes up at once; one with a bounty is a draft the host's sheet confirms (`createBountyPost`). */
    async postPlain(args: Record<string, unknown>): Promise<{ post: string }> {
      const id = await rpc<string>('forum_create_post', { p_title: textOf(args.title, 'title', 100), p_body: textOf(args.body, 'body', 20000) });
      return { post: id };
    },
    bountyDraft(args: Record<string, unknown>): BountyDraft {
      const bounty = (args.bounty ?? {}) as Record<string, unknown>;
      const { amount, days, visibility } = bounty;
      if (!(Number.isInteger(amount) && (amount as number) >= 1 && (amount as number) <= 100)) throw invalid('bounty.amount is a whole number of points from 1 to 100');
      if (days !== 1 && days !== 3 && days !== 7) throw invalid('bounty.days is 1, 3 or 7');
      if (visibility !== 'public' && visibility !== 'poster_only') throw invalid('bounty.visibility is "public" or "poster_only"');
      return { title: textOf(args.title, 'title', 100), body: textOf(args.body, 'body', 20000), amount: amount as number, days, visibility };
    },
    async createBountyPost(draft: BountyDraft): Promise<{ post: string }> {
      const id = await rpc<string>('forum_create_post', {
        p_title: draft.title, p_body: draft.body, p_amount: draft.amount, p_days: draft.days, p_visibility: draft.visibility,
      });
      return { post: id };
    },

    async reply(postId: unknown, text: unknown, options: { replyTo?: unknown } = {}): Promise<{ reply: string }> {
      const id = await rpc<string>('forum_reply', {
        p_post_id: idOf(postId, 'postId'),
        p_body: textOf(text, 'text', 20000),
        p_reply_to: options.replyTo === undefined || options.replyTo === null ? null : idOf(options.replyTo, 'replyTo'),
        p_as: null,
      });
      return { reply: id };
    },
    async react(args: Record<string, unknown>): Promise<void> {
      if (args.kind !== 'post' && args.kind !== 'reply') throw invalid('kind is "post" or "reply"');
      if (typeof args.on !== 'boolean') throw invalid('on is true (add) or false (take back)');
      await rpc('forum_react', { p_kind: args.kind, p_target: idOf(args.id, 'id'), p_emoji: textOf(args.emoji, 'emoji', 16), p_on: args.on, p_as: null });
    },
    async remove(args: Record<string, unknown>): Promise<void> {
      if ((args.reply === undefined) === (args.post === undefined)) throw invalid('Say what to remove: { reply: id } or { post: id }');
      if (args.reply !== undefined) await rpc('forum_delete_reply', { p_reply_id: idOf(args.reply, 'reply'), p_as: null });
      else await rpc('forum_delete_post', { p_post_id: idOf(args.post, 'post') });
    },
    async block(userId: unknown, on: unknown): Promise<void> {
      if (typeof on !== 'boolean') throw invalid('on is true (block) or false (unblock)');
      await rpc('forum_block', { p_user_id: userOf(userId, 'userId'), p_on: on });
    },
    /**
     * `gugu.forum.assign(postId, agentId?)`: the person picks one of their own agents in the host's sheet (`pick`, its assign
     * form, the post's title shown; `agentId` only preselects one), then the forum assigns it. Answers whom, or that they
     * cancelled; the forum's refusal (a new account, a closed post) comes back as the App's error.
     */
    async assign(postId: unknown, agentId: unknown, pick: (ask: DispatchAsk) => Promise<DispatchPicked>): Promise<{ assigned: { agent: string } } | { cancelled: true }> {
      const post = idOf(postId, 'postId');
      const preselect = agentId === undefined || agentId === null ? null : personId(userOf(agentId, 'agentId'));
      const read = await rpc<{ post: { title: string } }>('forum_read_post', { p_post_id: post, p_as: null });
      const picked = await pick({ assign: { title: read.post.title }, draft: false, offers: ['my-agent'], text: '', pills: [], chat: null, preselect, visible: false });
      if (!picked || !('agent' in picked.to)) return { cancelled: true };
      await rpc('forum_assign', { p_post_id: post, p_agent: userOf(picked.to.agent, 'agentId') });
      return { assigned: { agent: picked.to.agent } };
    },

    /** Settling is a draft the host's sheet confirms (`settle`): read here so the sheet can say who gets how much. */
    async awardDraft(postId: unknown, awards: unknown): Promise<AwardDraft> {
      const post = idOf(postId, 'postId');
      if (!Array.isArray(awards) || awards.length > 3) throw invalid('awards is a list of at most 3 { reply, amount }; [] ends the bounty without accepting');
      const read = await rpc<{ post: { title: string }; replies: Array<{ id: string; author_name: string | null; owner_name: string | null }> }>(
        'forum_read_post', { p_post_id: post, p_as: null });
      return {
        post,
        title: read.post.title,
        awards: awards.map((entry) => {
          const { reply, amount } = (entry ?? {}) as Record<string, unknown>;
          const id = idOf(reply, 'awards[].reply');
          const found = read.replies.find((candidate) => candidate.id === id);
          if (!found) throw invalid(`${id} is not a reply in this post`);
          if (!(Number.isInteger(amount) && (amount as number) >= 1)) throw invalid('awards[].amount is a whole number of points from 1');
          return { reply: id, amount: amount as number, to: found.owner_name ?? found.author_name ?? '' };
        }),
      };
    },
    async settle(draft: AwardDraft): Promise<{ status: string }> {
      const row = await rpc<{ status: string }>('forum_award', {
        p_post_id: draft.post,
        p_awards: draft.awards.map((award) => ({ reply_id: award.reply, amount: award.amount })),
      });
      return { status: row.status };
    },
  };
}

export type AppForum = ReturnType<typeof createAppForum>;

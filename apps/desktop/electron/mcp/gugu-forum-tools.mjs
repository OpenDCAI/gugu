// ── forum_ ── 论坛:agent 被主人指派到帖子上以后,在帖子里读和回。都以 **agent 自己**的身份(`p_as` = 它),
// 看得到什么由库里唯一的可见性谓词判(public.forum_reply_visible):仅楼主可见的回答,它只看得到自己这一家的。
// ❌ 以主人的视角读 —— 那是主人的可见域。两个都在目录里:route="forum" 的信封把 catalog_call 的写法写全了(deliveryEnvelope.ts)。
import { z } from 'zod'
import { decodeTypedId, encodeTypedId } from '../../../../packages/core/src/shared/typedId.mjs'

const postIdSchema = z.string().describe('post:<id>, as the delivery or forum_read gives it.')

const typed = (kind, raw) => (typeof raw === 'string' && raw ? encodeTypedId(kind, raw) : null)

/** forum_read_post 的整帖,换成带类型的 id;表情只给个数。 */
export function forumPostForAgent(read) {
  const reactionsOf = (kind, id) => (read.reactions ?? [])
    .filter((reaction) => reaction.target_kind === kind && reaction.target_id === id)
    .map((reaction) => `${reaction.emoji}×${reaction.count}`)
  const bounty = read.bounty
    ? {
        amount: read.bounty.amount,
        answers: read.bounty.visibility === 'poster_only' ? 'for the poster only until it settles' : 'public',
        status: read.bounty.status,
        deadline_at: read.bounty.deadline_at,
        ...(read.bounty.status === 'awarded'
          ? { accepted: read.bounty.awards.map((award) => ({ reply: typed('reply', award.reply_id), points: award.amount })) }
          : {}),
      }
    : null
  return {
    post: {
      id: typed('post', read.post.id),
      title: read.post.title,
      author: { id: typed('user', read.post.author_user_id), name: read.post.author_name },
      created_at: read.post.created_at,
      body: read.post.body,
      reactions: reactionsOf('post', read.post.id),
    },
    bounty,
    replies: (read.replies ?? []).map((reply) => ({
      id: typed('reply', reply.id),
      author: { id: typed('user', reply.author_user_id), name: reply.author_name, ...(reply.author_is_agent ? { agent: true, owner: reply.owner_name } : {}) },
      ...(reply.reply_to ? { reply_to: typed('reply', reply.reply_to) } : {}),
      ...(reply.to_poster_only ? { for_poster_only: true } : {}),
      created_at: reply.created_at,
      body: reply.body,
      reactions: reactionsOf('reply', reply.id),
    })),
  }
}

export const FORUM_TOOL_DEFS = [
  {
    name: 'forum_reply',
    description: 'Reply in a forum post you were assigned to (route="forum" deliveries). Optionally answer one reply (reply_to). Replies are public, or for the poster only while a poster-only bounty is open.',
    schema: z.object({
      post_id: postIdSchema,
      text: z.string().min(1),
      reply_to: z.string().optional().describe('reply:<id> of the reply you answer.'),
    }),
    handler: async (args, deps) => {
      const postId = decodeTypedId('post', args.post_id, 'post_id')
      const replyTo = args.reply_to ? decodeTypedId('reply', args.reply_to, 'reply_to') : null
      const id = await deps.restRpc('forum_reply', {
        p_post_id: postId, p_body: args.text, p_reply_to: replyTo, p_as: deps.context.agentId,
      }, 'public')
      if (typeof id !== 'string') throw new Error('forum_reply: the database returned no reply id')
      return `Posted ${encodeTypedId('reply', id)} in ${encodeTypedId('post', postId)}.`
    },
  },
  {
    name: 'forum_read',
    description: 'Read a forum post whole — body, bounty, and the replies you can see — as yourself.',
    schema: z.object({ post_id: postIdSchema }),
    handler: async (args, deps) => {
      const postId = decodeTypedId('post', args.post_id, 'post_id')
      const read = await deps.restRpc('forum_read_post', { p_post_id: postId, p_as: deps.context.agentId }, 'public')
      if (!read || typeof read !== 'object') throw new Error('forum_read: the database returned no post')
      return JSON.stringify(forumPostForAgent(read))
    },
  },
]

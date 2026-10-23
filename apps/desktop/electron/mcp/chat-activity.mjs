import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Metadata RPC is actor-scoped at the database, just like message_history_as. */
export function chatActivityTool(resolveChatId) {
  const schema = z.object({
    since: z.string().datetime({ offset: true }), until: z.string().datetime({ offset: true }),
    chat_id: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(4096).optional(),
  }).strict().refine(q => Date.parse(q.since) < Date.parse(q.until), 'until must be later than since')
  return {
    name: 'activity_chat_list',
    description: 'Messages in your chats by time: which chat, message and sender, and when. Never reads message bodies. Uses your own current membership, history and whisper permissions, including on topics; a chat you cannot see is refused. Deleted or no-longer-visible messages are omitted; membership, read and reaction changes are not included. Use message_history separately when context is needed.',
    schema,
    handler: async (raw, deps) => {
      const q = schema.parse(raw)
      const chatId = q.chat_id ? await resolveChatId(q.chat_id, deps) : null
      const signature = createHash('sha256').update(JSON.stringify([deps.context.agentId, q.since, q.until, chatId])).digest('hex')
      let after = 0
      let through = null
      if (q.cursor) {
        let c
        try { c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString()) } catch { throw new Error('Invalid chat activity cursor') }
        if (!c || c.signature !== signature || !Number.isSafeInteger(c.after) || c.after < 0 || !Number.isSafeInteger(c.through) || c.through < c.after) {
          throw new Error('Chat activity cursor does not match the actor or query')
        }
        after = c.after
        through = c.through
      }
      const result = await deps.restRpc('activity_metadata_as', {
        p_as_user_id: deps.context.agentId, p_since: q.since, p_until: q.until,
        p_chat_id: chatId, p_after_revision: after, p_through_revision: through, p_limit: q.limit,
      })
      if (!result || !Array.isArray(result.events) || !Number.isSafeInteger(result.through_revision)) {
        throw new Error('Chat activity metadata returned an invalid result; no activity conclusion can be drawn')
      }
      const { next_revision: next, ...page } = result
      // JSON text, like every IM tool: the dispatcher types its ids (msg:, user:) and the MCP server returns it as text.
      return JSON.stringify({ ...page, next_cursor: next == null ? null : Buffer.from(JSON.stringify({ signature, after: next, through: result.through_revision })).toString('base64url') })
    },
  }
}

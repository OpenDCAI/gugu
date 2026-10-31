// gugu-dev#181 ⑨「需要你」: a question an agent asks while working on a group's message goes into that group too, as a
// question card the agent posts quoting that message. The owner answers it there by replying to it (a pick on the card
// is that reply); the session's settlement says whether it still waits, so the card is never edited after it is sent.
//   · Only a group or its topic: in a direct chat the agent's chat page already shows the question under the conversation.
//   · The message id is the question's own uuid, so a retried ask converges on the same message.
import type { RemoteSessionCaller } from '@gugu/session-core/session-record/contract'
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink'
import { serializeComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { makeChatClient } from '../supabase'

type Question = { question: string; options: ReadonlyArray<{ label: string }>; multi_select?: boolean }

export interface QuestionCardInput {
  auth: { accessToken: string; userId: string }
  /** The asking session, as the host knows it (its agent, this machine). */
  caller: Pick<RemoteSessionCaller, 'agentUserId' | 'deviceId' | 'deviceLabel' | 'sessionId'>
  projectId: string
  /** What `session_ask_user` returned: `question_id` and the `source_link` it was asked from. */
  asked: unknown
  /** The tool call's `questions`, as the agent passed them (already checked by the ask). */
  questions: unknown
}

/**
 * `asked` once the card is in its group (or it needs none). A card that could not be posted leaves the question waiting
 * in the session all the same, so the ask still succeeds and says so in `group_card`.
 */
export async function withQuestionCard(input: QuestionCardInput): Promise<unknown> {
  try {
    await postQuestionCard(input)
    return input.asked
  } catch (error) {
    return { ...(input.asked as object), group_card: { status: 'unavailable', error: error instanceof Error ? error.message : String(error) } }
  }
}

async function postQuestionCard({ auth, caller, projectId, asked, questions }: QuestionCardInput): Promise<void> {
  const result = asked as { question_id?: unknown; source_link?: unknown } | null
  const questionId = typeof result?.question_id === 'string' ? result.question_id : null
  const source = typeof result?.source_link === 'string' ? parseConversationLink(result.source_link) : null
  const all = questions as readonly Question[]
  const first = all[0]
  if (!questionId || !source?.messageId || !first) return
  const chat = makeChatClient(auth.accessToken)
  const { data: room, error: roomError } = await chat.from('chats').select('kind').eq('id', source.chatId).maybeSingle()
  if (roomError) throw new Error(`read chat ${source.chatId}: ${roomError.message}`)
  const kind = (room as { kind?: string } | null)?.kind
  if (kind !== 'group' && kind !== 'topic') return
  if (!caller.agentUserId) throw new Error('the agent has no 咕咕 identity yet')
  const onePick = all.length === 1 && first.multi_select !== true
  const { error } = await chat.rpc('send_message_idempotent', {
    p_message_id: questionId.replace(/^agent-question:/, ''),
    p_chat_id: source.chatId,
    p_sender_user_id: caller.agentUserId,
    p_to_user_ids: [],
    p_content: serializeComposerCard({
      v: 1,
      type: 'question',
      text: first.question,
      options: onePick ? first.options.map((option) => option.label) : [],
      ownerUserId: auth.userId,
      questionId,
      sessionId: caller.sessionId,
      projectId,
      deviceId: caller.deviceId,
      machineLabel: caller.deviceLabel ?? '',
    }),
    p_content_type: 'card',
    p_reply_to_message_id: source.messageId,
    p_thread_root_id: null,
    p_is_thread_root: false,
    p_is_whisper: false,
  })
  if (error) throw new Error(`write failed: ${error.message}`)
}

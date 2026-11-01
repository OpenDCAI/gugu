// gugu-dev#181「派任务」: a task dispatched from a chat's composer lands its first turn as a task card in that chat.
//
// It is the chat-page first turn (main.ts `landChatPageFirstTurn`) with another landing: the same idempotent owner
// write keyed by the session's stable `initialMessageId`, after the agent's cloud identity has settled — by then a
// group it was born in has answered its join (joined, or queued for the owner's approval) and its name is final.
//   · The card is the owner's own message and names nobody: the cloud delivery trigger skips cards, so it wakes no
//     one; the words reach the new agent only as this first turn.
//   · In a group the first turn is that group's delivery envelope for the card, so the agent answers in the group,
//     quoting the card. Until the group has let it in (approval pending, or refused) it cannot post there: the
//     envelope says to answer in its own session instead.
//   · In a direct chat with a person the agent can never join: the card stays there and the agent gets the plain
//     words — its answer is its own session.
import { listAgents } from '@gugu/core'
import type { GuguIdentity } from '@gugu/core/local/agent/deliveryEnvelope'
import { buildAgentDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { serializeComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { makeChatClient, makeIdentityClient } from '../supabase'
import { awaitSessionpageCloudIdentity } from './emdash-agent-provisioning'

export interface TaskCardFirstTurnInput {
  auth: { accessToken: string; userId: string }
  sessionId: string
  projectId: string
  agentUserId: string
  chatId: string
  messageId: string
  text: string
  deviceId: string
  machineLabel: string
  senderIdentities: Map<string, GuguIdentity>
  timestamp: string
  env: NodeJS.ProcessEnv
}

/** `envelope` = the first turn is a chat delivery the agent answers in that chat; otherwise plain words. */
export interface TaskCardFirstTurn {
  /** Where the agent answers: the chat the card is in. */
  chatId: string
  firstTurn: string
  envelope: boolean
}

// 先看再发:没进群时 message_send 必然被拒,而有的 harness 把一次失败的咕咕工具调用记成整轮失败(Codex 实测)。
export const TASK_CARD_NOT_MEMBER_HINT =
  '这是你的任务卡。你现在还不是这个群的成员：交结果之前先用 message_members 看你是不是这个群的成员 —— 是，就照常在群里回、引用这张卡；还不是，就把结果直接回在你自己的会话里，不往群里发。'

export async function landTaskCardFirstTurn(input: TaskCardFirstTurnInput): Promise<TaskCardFirstTurn> {
  const text = input.text.trim()
  if (!text) throw new Error(`task card for ${input.sessionId} has no text`)
  await awaitSessionpageCloudIdentity(input.agentUserId)
  const agent = (await listAgents(input.env, { includeGuests: true })).find((row) => row.gugu_user_id === input.agentUserId)
  if (!agent) throw new Error(`task card for ${input.sessionId}: no roster row for agent ${input.agentUserId}`)

  const chat = makeChatClient(input.auth.accessToken)
  const { data: room, error: roomError } = await chat.from('chats')
    .select('id, kind, public_id, name').eq('id', input.chatId).maybeSingle()
  if (roomError) throw new Error(`task card for ${input.sessionId}: read chat ${input.chatId}: ${roomError.message}`)
  if (!room) throw new Error(`task card for ${input.sessionId}: chat ${input.chatId} is not visible to its owner`)
  const kind = (room as { kind?: string | null }).kind ?? null
  const { data: face, error: faceError } = await makeIdentityClient(input.auth.accessToken).from('users')
    .select('avatar').eq('id', input.agentUserId).maybeSingle()
  if (faceError) throw new Error(`task card for ${input.sessionId}: read the agent's avatar: ${faceError.message}`)

  const { error: writeError } = await chat.rpc('send_message_idempotent', {
    p_message_id: input.messageId,
    p_chat_id: input.chatId,
    p_sender_user_id: input.auth.userId,
    p_to_user_ids: [],
    p_content: serializeComposerCard({
      v: 1,
      type: 'task',
      text,
      agentUserId: input.agentUserId,
      agentName: agent.name,
      agentType: agent.agent_type,
      agentAvatar: (face as { avatar?: string | null } | null)?.avatar ?? null,
      sessionId: input.sessionId,
      projectId: input.projectId,
      deviceId: input.deviceId,
      machineLabel: input.machineLabel,
    }),
    p_content_type: 'card',
    p_reply_to_message_id: null,
    p_thread_root_id: null,
    p_is_thread_root: false,
    p_is_whisper: false,
  })
  if (writeError) throw new Error(`task card for ${input.sessionId}: write failed: ${writeError.message}`)

  if (kind !== 'group') return { chatId: input.chatId, firstTurn: text, envelope: false }

  const { data: seat, error: seatError } = await chat.from('active_members')
    .select('user_id').eq('chat_id', input.chatId).eq('user_id', input.agentUserId).maybeSingle()
  if (seatError) throw new Error(`task card for ${input.sessionId}: read the agent's seat: ${seatError.message}`)
  let notMemberHint = TASK_CARD_NOT_MEMBER_HINT
  if (!seat) {
    const { data: request, error: requestError } = await chat.from('group_join_requests')
      .select('status').eq('chat_id', input.chatId).eq('requester_user_id', input.agentUserId)
      .eq('status', 'pending').maybeSingle()
    if (requestError) throw new Error(`task card for ${input.sessionId}: read the agent's join request: ${requestError.message}`)
    if (request) notMemberHint += '你的入群申请正在等待群管理员同意。'
  }
  const envelope = buildAgentDeliveryEnvelope(
    {
      guguUserId: input.agentUserId,
      chatId: input.chatId,
      messageId: input.messageId,
      senderUserId: input.auth.userId,
      content: text,
      replyTo: null,
      threadRootId: null,
    },
    input.senderIdentities,
    {
      publicId: (room as { public_id?: number | null }).public_id ?? null,
      name: (room as { name?: string | null }).name ?? null,
      kind: 'group',
    },
    input.timestamp,
    null,
    undefined,
    seat ? {} : { messageContext: notMemberHint },
  )
  return { chatId: input.chatId, firstTurn: envelope, envelope: true }
}

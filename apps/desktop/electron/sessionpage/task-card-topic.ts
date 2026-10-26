// OpenDCAI/gugu#446 项目群里派出的任务住在它那张卡开出的话题里(owner 10-26 稿:任务那枚页签 = 话题,
// 任务 agent 不在群聊说话)。卡落下之后(task-card-first-turn.ts),在项目群里:
//   · agent 在群里的座位转 passive:群聊主线不点名就不叫醒它(被 @ 仍会,所以主线的 @ 候选里也没有它);
//   · 卡上开一条话题:主人开、名字 = 任务首行、成员 = 这个 agent。同一张卡只开一条 —— spawn 会重试,先列再开;
//   · 首轮是这条话题的投递,agent 每一轮都回在话题里,主人在话题里说的就是下一轮。
// 普通群照旧:卡在群里、agent 在群里回。
import { createGroupAdmin } from '@gugu/core/cloud/groupAdmin'
import { makeChatClient, makeIdentityClient } from '../supabase'
import { listProjectGroupIds, readProjectGroupId } from './sessionpage-project-groups'

export interface TaskTopic {
  chatId: string
  publicId: number | null
  name: string | null
}

const TOPIC_NAME_CHARS = 40

/** 话题名 = 任务首行,截法同库里的 chat.topic_name_from_message(前 40 个字,超出加「…」)。 */
export function taskTopicName(text: string): string {
  const firstLine = (text.trim().split('\n', 1)[0] ?? '').trim()
  const chars = Array.from(firstLine)
  return chars.length <= TOPIC_NAME_CHARS ? firstLine : `${chars.slice(0, TOPIC_NAME_CHARS).join('')}…`
}

/**
 * 这个群是不是项目群:这个账号名下有项目绑着它(spec ⑨ 项目 = 群)。先问本机的「项目 → 群」映射(刚建的项目
 * 可能还没记到账号上),再问账号上的项目记录(identity.device_projects,只有本人读得到;别的机器上的项目绑的群在这里)。
 */
export async function isProjectGroup(input: {
  accessToken: string
  ownerUserId: string
  projectId: string
  chatId: string
  env: NodeJS.ProcessEnv
}): Promise<boolean> {
  if ((await readProjectGroupId(input.projectId, input.ownerUserId, input.env)) === input.chatId) return true
  if ((await listProjectGroupIds(input.ownerUserId, input.env)).some((row) => row.chatId === input.chatId)) return true
  const { data, error } = await makeIdentityClient(input.accessToken).from('device_projects')
    .select('local_project_id').eq('user_id', input.ownerUserId).eq('chat_id', input.chatId).limit(1)
  if (error) throw new Error(`read the account's project groups: ${error.message}`)
  return Array.isArray(data) && data.length > 0
}

type TopicRow = { chat_id?: unknown; source_message_id?: unknown }

/** 座位转 passive,再找或开卡上的话题。两步都幂等:同一张卡重来一遍落到同一条话题。 */
export async function landTaskTopic(input: {
  accessToken: string
  ownerUserId: string
  chatId: string
  messageId: string
  agentUserId: string
  text: string
}): Promise<TaskTopic> {
  const chat = makeChatClient(input.accessToken)
  await createGroupAdmin(chat, input.ownerUserId).setListenMode(input.chatId, input.agentUserId, 'passive')

  const { data: listed, error: listError } = await chat.rpc('list_topics_of_chat', {
    p_source_chat_id: input.chatId,
    p_as_user_id: input.ownerUserId,
  })
  if (listError) throw new Error(`list the topics of ${input.chatId}: ${listError.message}`)
  const found = (Array.isArray(listed) ? listed as TopicRow[] : [])
    .find((row) => row.source_message_id === input.messageId)
  let topicId = typeof found?.chat_id === 'string' && found.chat_id ? found.chat_id : null
  if (!topicId) {
    const { data, error } = await chat.rpc('create_topic', {
      p_source_chat_id: input.chatId,
      p_source_message_id: input.messageId,
      p_name: taskTopicName(input.text),
      p_member_user_ids: [input.agentUserId],
      p_as_user_id: input.ownerUserId,
    })
    if (error) throw new Error(`open the task topic on card ${input.messageId}: ${error.message}`)
    const row = (Array.isArray(data) ? data[0] : data) as TopicRow | undefined
    topicId = typeof row?.chat_id === 'string' && row.chat_id ? row.chat_id : null
    if (!topicId) throw new Error(`open the task topic on card ${input.messageId}: create_topic returned no chat_id`)
  }

  const { data: topic, error: topicError } = await chat.from('chats')
    .select('id, public_id, name').eq('id', topicId).maybeSingle()
  if (topicError) throw new Error(`read the task topic ${topicId}: ${topicError.message}`)
  if (!topic) throw new Error(`the task topic ${topicId} is not visible to its owner`)
  return {
    chatId: topicId,
    publicId: (topic as { public_id?: number | null }).public_id ?? null,
    name: (topic as { name?: string | null }).name ?? null,
  }
}

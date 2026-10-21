/**
 * 消息 reaction 的唯一目录(#6562):picker 画哪几个、每个叫什么、agent 收到的通知里怎么解释,都从这里取。
 *
 * 库里 `chat.message_reactions.emoji` 只存表情字符本身(没有 CHECK、没有白名单),给 agent 的通知也只写表情;
 * 名字不进库。❌ 在库里或 i18n 词表里再写一份名字表 —— 两份表迟早会漂,漂了人看到的和 agent 读到的就不是一个意思。
 */
export interface ReactionEntry {
  emoji: string
  zh: string
  en: string
  /** mood = 表态;status = 带工作含义的回应(收到 / 在看 / 稍等 / 完成 / 疑问 / 不对),picker 分两行画。 */
  kind: 'mood' | 'status'
}

// status 一组参照飞书(#6562 调研):
// 开放平台 emoji_type 表(open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce)有 Get / OK /
// OnIt / OneSecond / DONE / No / CrossMark;帮助中心《使用表情回复消息》说「稍等」「在做了」这类表情用来表达工作状态。
// 飞书用自绘贴纸,这里用最接近的 Unicode 表情 + 名字;❓ 飞书没有,是给 agent 的「我没看懂 / 有疑问」信号。
export const REACTIONS: readonly ReactionEntry[] = [
  { emoji: '👍', zh: '赞', en: 'Like', kind: 'mood' },
  { emoji: '❤️', zh: '爱心', en: 'Love', kind: 'mood' },
  { emoji: '😂', zh: '笑哭', en: 'Haha', kind: 'mood' },
  { emoji: '😮', zh: '惊讶', en: 'Wow', kind: 'mood' },
  { emoji: '😢', zh: '难过', en: 'Sad', kind: 'mood' },
  { emoji: '🙏', zh: '感谢', en: 'Thanks', kind: 'mood' },
  { emoji: '👌', zh: '收到', en: 'Got it', kind: 'status' },
  { emoji: '👀', zh: '在看', en: 'On it', kind: 'status' },
  { emoji: '⏳', zh: '稍等', en: 'One moment', kind: 'status' },
  { emoji: '✅', zh: '完成', en: 'Done', kind: 'status' },
  { emoji: '❓', zh: '疑问', en: 'Question', kind: 'status' },
  { emoji: '❌', zh: '不对', en: 'No', kind: 'status' },
]

/** 人在界面上看到的名字:中文界面给中文,其余给英文;目录外的表情没有名字。 */
export function reactionLabel(emoji: string, language: string): string | null {
  const entry = REACTIONS.find((reaction) => reaction.emoji === emoji)
  if (!entry) return null
  return language.toLowerCase().startsWith('zh') ? entry.zh : entry.en
}

/**
 * 一条系统通知里出现了哪些目录里的表情 → 每个一行「表情 = 中文名 (English)」,给 agent 读;一个都没有就 undefined。
 * 通知由库写、只带表情(见 gugu-supabase `20260926103000_agent_reaction_notice_6562.sql`),名字在这里补上。
 */
export function describeReactions(text: string): string | undefined {
  const lines = REACTIONS
    .filter((reaction) => text.includes(reaction.emoji))
    .map((reaction) => `${reaction.emoji} = ${reaction.zh} (${reaction.en})`)
  return lines.length > 0 ? lines.join('\n') : undefined
}

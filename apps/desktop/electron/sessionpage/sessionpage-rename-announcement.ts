// #6396 一条会话页会话的 agent 登记到云端时,会话起来时的名字已经用过了(序号只增不减),服务端登记成了下一个
// ⇒ 在那条会话的对话里画一行告知。桌面主进程与网页版无头宿主共用这一份(❌ 各写一份:措辞与字段会漂)。
// #6490 这里只画给人看的那一行,❌ 再往 agent 的上下文里推改名:名字不在 agent 的上下文里(身份块只锚 participant_id,
// 要知道就调 profile_whoami),也就没有要纠正的东西 —— 不依赖这条一次性、只到得了聊天面板会话、进程一重启就丢的推送。
import type { AcpAnnounceSessionInput } from '../session/main/core/acp/controller'

export type SessionpageAgentNameTaken = {
  sessionId: string
  /** 服务端登记成的名字。 */
  displayName: string
  /** 会话起来时本机取的名字,登记时已被占用。 */
  previousName: string
}

export function sessionpageRenameAnnouncement(rename: SessionpageAgentNameTaken): AcpAnnounceSessionInput {
  return {
    sessionId: rename.sessionId,
    notice: {
      code: 'agent-renamed',
      detail: `"${rename.previousName}" had already been used when this session registered its identity; registered as "${rename.displayName}"`,
      previousValue: rename.previousName,
      effectiveValue: rename.displayName,
    },
  }
}

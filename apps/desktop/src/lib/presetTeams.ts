/**
 * Projects a database-authored preset catalog entry into the team builder.
 *
 * Catalog content belongs to presetTeamCatalog; this module owns only the
 * projection into BuildAgentWizard's transient AgentTeam shape.
 */

import type { AgentTeam } from '../components/BuildAgentWizard'
import type {
  PresetTeamCatalogEntry,
  PresetTeamCatalogIcon,
  PresetTeamCatalogRole,
} from './presetTeamCatalog'

export type PresetTeamIcon = PresetTeamCatalogIcon
export type PresetRole = PresetTeamCatalogRole
export type PresetTeam = PresetTeamCatalogEntry

// @@@3874 — these strings are agent prompt data, not UI chrome: group_prompt must
// use the same language as the DB-curated remainder of the document. The catalog
// currently has Chinese content only, so this copy is deliberately fixed and is
// narrowly exempted from hardcodedCjkUiCopy by these property names.
const TEAM_CHARTER_COPY = {
  charterHeader: '【怎么协作】',
  charterClaim: '· 认领再动手：先说清我接哪一格、交付物是什么、怎样算完成。已经有人认领的，不重复接。',
  charterHandoff: '· 交接要带四样：产出 · 依据（指到具体来源或上一条交付）· 没做到的部分 · 下一步该谁。只说「做完了」不算交接。',
  charterWait: '· 等待要出声：上游还没给你输入时，不许自己编一个接着做 —— 把「我在等谁的什么」说出来。',
  charterPushback: '· 打回要指名：审查角色只对着验收标准判，不替别人重写；不过就点名打回，写清哪一条没过、该怎么改。',
  rosterHeader: '【本群分工】',
  rosterHint: '（这些就是名录里的显示名；要谁做事，按名字查 id 再点名。）',
  rosterClosing: '· 收尾只有一个人：由{{lead}}宣布收敛，并列清已达成、未达成、每条结论的依据。其他人不宣布整体完成。',
} as const

/**
 * @@@team-charter 协作层：一份声明，14 个预设团队共用。
 *
 * 现有的各队章程写的全是**质量标准**（什么算好的交付、什么不许编），一个字没写**协作机制**：
 * 谁该找谁、什么时候交接、交接要带什么、怎么知道自己该等。这一段补的就是那一格。
 *
 * **为什么不复刻 DAG 调度器**：多 agent 编排产品（openteams 一类）用的是确定性调度器 + 状态机，
 * 并明确不让 agent 自己调度——agent 调度会分配混乱、错配依赖。所以这里也**不用 prompt 去模拟调度器**，
 * 那等于把人家特意避开的东西请回来。改成把对调度器的需求消掉：DAG 在那儿其实只防两件事，
 * 「上游没出来就开工」和「重复做或没人做」，两件都能本地防住 —— 前者靠「等待要出声」，
 * 后者靠「认领再动手」。并行、拓扑序、无环**不承诺**：群聊里没有调度器。
 *
 * ⚠️ 这一段只放这一处。抄进 14 份 group_prompt = 造 14 个会漂移的副本，而漂移不会红。
 */
function teamCollaborationClause(): string {
  return [
    TEAM_CHARTER_COPY.charterHeader,
    TEAM_CHARTER_COPY.charterClaim,
    TEAM_CHARTER_COPY.charterHandoff,
    TEAM_CHARTER_COPY.charterWait,
    TEAM_CHARTER_COPY.charterPushback,
  ].join('\n')
}

/**
 * @@@team-charter 名册从 roles 生成，❌ 不手写。
 *
 * 这里有一条**结构性保证**要利用：下面 `members` 里 `displayName: role.title`，
 * 所以「章程里写的名字」与「agent 在 gugu_conv(members) 名录里查到的显示名」**同源**，
 * 不靠人去对齐 —— 手写名册会在改角色名时安静地对不上，而对不上不会报错，
 * 只会让 agent 按一个不存在的名字点名。
 *
 * 收尾人取 roles[0]：14 个预设队的首个角色都是主导角色（综述主编 / 行程主理人 / 条款主编 …）。
 */
function teamRoster(roles: readonly PresetRole[]): string {
  const lines = roles.map((role) => `· ${role.title} —— ${role.responsibility}`)
  const lead = roles[0]?.title
  return [
    TEAM_CHARTER_COPY.rosterHeader,
    ...lines,
    TEAM_CHARTER_COPY.rosterHint,
    ...(lead ? [TEAM_CHARTER_COPY.rosterClosing.replace('{{lead}}', lead)] : []),
  ].join('\n')
}

/** 章程 = 共享协作层 + 本队名册（生成） + 本队既有质量层（原样保留）。 */
export function composeTeamCharter(team: PresetTeam): string {
  return [teamCollaborationClause(), teamRoster(team.roles), team.groupPrompt]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
}

let presetMemberSeq = 0

export function presetTeamToAgentTeam(team: PresetTeam): AgentTeam {
  return {
    userDescription: team.description,
    teamName: team.name,
    groupPrompt: composeTeamCharter(team),
    starterPrompt: team.starterPrompt,
    members: team.roles.map((role) => ({
      tempId: `preset-${team.id}-${role.key}-${presetMemberSeq++}`,
      role: role.title,
      displayName: role.title,
      description: role.responsibility,
      avatarUrl: null,
      avatarSeed: role.avatarSeed,
      engineId: role.engine,
      specialFocus: role.persona,
    })),
  }
}

/**
 * spec agent-status-vocabulary「展示」—— 一个 agent 在任何一面上画成什么,只在这里定义一次。
 *
 * 三根互相独立的轴:可达(云端:账号 / 设备 / 意图 / runtime)× 读数(宿主的状态写入者)× 未读(看的人)。
 * 会话页、聊天、手机都调同一个 `presentAgentStatus`,界面之间只在密度上不同(整句、点、字形),
 * ❌ 在界面里另写一份「这个状态叫什么、什么颜色、动不动」。
 */
import type { AgentStatusView, AgentWaitKind } from './agentStatus'

/** 可达:只有聊天侧有这一轴(会话页与手机会话行上的会话就在那台机器上)。 */
export type AgentReachability = 'online' | 'offline' | 'removed' | 'pending'

export const AGENT_STATUS_TONES = [
  'running',
  'parked',
  'needs_user',
  'error',
  'done',
  'idle',
  'online',
  'offline',
  'removed',
  'pending',
  'none',
] as const
export type AgentStatusTone = (typeof AGENT_STATUS_TONES)[number]

/**
 * 文案键:三套文案目录(会话页 `messages.ts`、咕咕 i18next `common`、手机同一个 i18next)里都叫 `agentStatus.<label>`,
 * 逐字一致由 parity 测试钉住。
 */
export const AGENT_STATUS_LABELS = [
  'running',
  'parked',
  'needsApproval',
  'needsAnswer',
  'needsPlanReview',
  'needsAction',
  'error',
  'done',
  'idle',
  'online',
  'offline',
  'removed',
  'pending',
  'none',
] as const
export type AgentStatusLabel = (typeof AGENT_STATUS_LABELS)[number]

export interface AgentStatusPresentation {
  tone: AgentStatusTone
  label: AgentStatusLabel
  /** 画动效(转圈 / 脉冲):只有一轮在飞。park 是同一枚字形、静止。 */
  animate: boolean
  /** 未读加粗:这一轮做完了、看的人还没看。做完不另上色。 */
  emphasis: boolean
}

const WAIT_LABEL: Readonly<Record<AgentWaitKind, AgentStatusLabel>> = {
  approval: 'needsApproval',
  question: 'needsAnswer',
  plan: 'needsPlanReview',
  dialog: 'needsAction',
}

const still = (tone: AgentStatusTone, label: AgentStatusLabel = tone as AgentStatusLabel): AgentStatusPresentation => ({
  tone,
  label,
  animate: false,
  emphasis: false,
})

/**
 * 三根轴 → 一格状态。
 * - 可达压过读数:已移除 > 不在线 > 首次快照还在途。
 * - 没有读数:可达时是「在线」,否则(会话页上没有状态源的终端会话)是 `none`,❌ 画成空闲。
 * - 读数:在跑(动)/ 后台在跑(静止)/ 需要你(按在等什么写)/ 出错 / 做完(未读才算,加粗不上色)/ 空闲
 *   (聊天侧可达时写「在线」)。
 */
export function presentAgentStatus(input: {
  reading: AgentStatusView | null
  reachability?: AgentReachability
  unseen?: boolean
}): AgentStatusPresentation {
  const { reading, reachability, unseen = false } = input
  if (reachability === 'removed' || reachability === 'offline' || reachability === 'pending') return still(reachability)
  const idle = reachability === 'online' ? still('online') : still('idle')
  if (reading === null) return reachability === 'online' ? idle : still('none')
  switch (reading.status) {
    case 'working':
      return reading.detail === 'parked' ? still('parked') : { tone: 'running', label: 'running', animate: true, emphasis: false }
    case 'needs_user':
      return still('needs_user', reading.detail && reading.detail in WAIT_LABEL ? WAIT_LABEL[reading.detail as AgentWaitKind] : 'needsAction')
    case 'error':
      return still('error')
    case 'idle':
      return reading.detail === 'done' && unseen ? { tone: 'done', label: 'done', animate: false, emphasis: true } : idle
  }
}

/**
 * 一格状态的颜色:设计 token 名(`tokens.css` 的 `--agent-tone-*`);`null` = 不上色(做完、空闲、没有状态源)。
 * 在跑与后台在跑同一个橙,需要你 = --warn 黄,出错 = --danger 红,在线 = 绿(可达,聊天侧)。
 */
export function agentStatusColorVar(tone: AgentStatusTone): string | null {
  switch (tone) {
    case 'running':
    case 'parked':
      return 'var(--agent-tone-running)'
    case 'needs_user':
      return 'var(--agent-tone-needs-user)'
    case 'error':
      return 'var(--agent-tone-error)'
    case 'online':
      return 'var(--agent-tone-online)'
    case 'removed':
      return 'var(--agent-tone-removed)'
    case 'offline':
    case 'pending':
      return 'var(--agent-tone-muted)'
    case 'done':
    case 'idle':
    case 'none':
      return null
  }
}

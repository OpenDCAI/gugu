/**
 * spec agent-status —— agent 状态的唯一词表。
 *
 * 读数只有一个来源:会话页的状态写入者对一条会话的事件日志 reduce 出来的 `AgentStatusReading`。
 * 库行、IPC、云端 presence 行、手机线上、心跳摘要、工具返回都是它的副本或下面这些具名投影,
 * ❌ 在别处再定义一遍这套词或各自推导。
 */

/** 基础态(功能):决定做什么的读者只读它。 */
export const AGENT_STATUSES = ['idle', 'working', 'needs_user', 'error'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** 在等人的哪一件事(显示)。 */
export const AGENT_WAIT_KINDS = ['approval', 'question', 'plan', 'dialog'] as const;
export type AgentWaitKind = (typeof AGENT_WAIT_KINDS)[number];

/**
 * 附属态(显示):
 *  - working:`running`(有一轮在飞)| `parked`(只剩后台任务 / 定时唤醒)
 *  - needs_user:开着的等待里优先级最高的那一种
 *  - idle:`done`(上一轮正常做完)| `plain`
 *  - error:没有附属态
 */
export const AGENT_STATUS_DETAILS = ['running', 'parked', ...AGENT_WAIT_KINDS, 'done', 'plain'] as const;
export type AgentStatusDetail = (typeof AGENT_STATUS_DETAILS)[number];

/** 回合之外仍开着的自驱工作:后台任务优先于定时唤醒。 */
export type AgentBackgroundWork = 'running' | 'scheduled';

export interface AgentStatusReading {
  status: AgentStatus;
  detail: AgentStatusDetail | null;
  /** agent 在干活(含停在等人上)。park 时为 false,而基础态仍是 working。功能读者读它,❌ 读 detail。 */
  running: boolean;
  background: AgentBackgroundWork | null;
}

const DETAILS_OF: Record<AgentStatus, readonly AgentStatusDetail[]> = {
  working: ['running', 'parked'],
  needs_user: AGENT_WAIT_KINDS,
  idle: ['done', 'plain'],
  error: [],
};

/**
 * 读一个存下来或传过来的基础态。`null` / 缺省 = 这条会话没有状态源,原样是 `null`(❌ 当成 idle)。
 * 旧版本写下的词在这里按它当时的意思显式换算(`needs_approval` / `awaiting-input` 是等人,`completed` 是做完回到空闲;
 * 跨版本存活的记录:库行、落盘的生命周期账本、老宿主的线上字段);认不出的词是协议被破坏,响亮地抛。
 */
export function parseAgentStatus(raw: unknown): AgentStatus | null {
  if (raw === null || raw === undefined) return null;
  if ((AGENT_STATUSES as readonly unknown[]).includes(raw)) return raw as AgentStatus;
  switch (raw) {
    case 'needs_approval':
    case 'awaiting-input':
      return 'needs_user';
    case 'completed':
      return 'idle';
    default:
      throw new Error(`unknown agent status: ${String(raw)}`);
  }
}

/** 读附属态。它只管显示:缺省、认不出或与基础态不配(旧行、新版本的词)一律是 `null`,画基础态。 */
export function parseAgentStatusDetail(raw: unknown, status: AgentStatus | null): AgentStatusDetail | null {
  if (status === null || typeof raw !== 'string') return null;
  return (DETAILS_OF[status] as readonly string[]).includes(raw) ? (raw as AgentStatusDetail) : null;
}

/** 读一份传过来的读数(IPC / 手机线上 / 心跳摘要)。`null` = 没有状态源;形状不对响亮地抛。 */
export function parseAgentStatusReading(raw: unknown): AgentStatusReading | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('agent status reading is not an object');
  const r = raw as Record<string, unknown>;
  const status = parseAgentStatus(r.status);
  if (status === null) throw new Error('agent status reading has no status');
  if (typeof r.running !== 'boolean') throw new Error('agent status reading has no running');
  const background = r.background ?? null;
  if (background !== null && background !== 'running' && background !== 'scheduled') {
    throw new Error(`agent status reading has unknown background: ${String(background)}`);
  }
  return { status, detail: parseAgentStatusDetail(r.detail, status), running: r.running, background };
}

/**
 * 读数离开宿主进程时的样子:基础态 + 附属态。功能布尔(`running` / `background`)只给宿主进程内的读者,
 * 不上网 —— 云端 presence 行、手机线上与心跳摘要、扩展 API 都只带这一份。
 */
export type AgentStatusView = Pick<AgentStatusReading, 'status' | 'detail'>;

export function agentStatusView(reading: AgentStatusView | null): AgentStatusView | null {
  return reading ? { status: reading.status, detail: reading.detail } : null;
}

/** 读一份过网的读数。`null` / 缺省 = 没有读数;形状不对、词认不出响亮地抛。 */
export function parseAgentStatusView(raw: unknown): AgentStatusView | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('agent status view is not an object');
  const r = raw as Record<string, unknown>;
  const status = parseAgentStatus(r.status);
  if (status === null) throw new Error('agent status view has no status');
  return { status, detail: parseAgentStatusDetail(r.detail, status) };
}

/** 一个基础态的读数(只知道基础态的来源:老宿主的线上字段、老 presence 行)。 */
export function readingOfStatus(status: AgentStatus): AgentStatusReading {
  return { status, detail: null, running: status === 'working' || status === 'needs_user', background: null };
}

/**
 * 写给老客户端的旧词 —— 只用在为兼容保留的字段上(手机线上与心跳摘要的 `agentStatus`)。
 * 老版本认得 `needs_approval`,认不得 `needs_user`(认不出就画成空闲)。
 */
export function legacyAgentStatusWord(status: AgentStatus | null): string | null {
  return status === 'needs_user' ? 'needs_approval' : status;
}

// ── 具名投影 ─────────────────────────────────────────────────────────────────

/** 在干活(含 park、含停在等人上)。云端 `activity_status` 的 running 就是它 —— 老客户端只读得懂这一维。 */
export function isAgentActive(reading: Pick<AgentStatusReading, 'status'> | null): boolean {
  return reading !== null && (reading.status === 'working' || reading.status === 'needs_user');
}

/**
 * #6264 server 换版时这条会话算不算忙:在干活(working / needs_user),**并且**账号进程一重启就会打断它。
 * 「会不会被打断」只读这条会话自己的进程记录(宿主 session-process 的 `home`,❌ 再从设置推 tmux):
 * ACP 恒随宿主;终端(pty)会话只在进程归宿主(`host`)时随宿主死,归 tmux 的换版后照名字接回;
 * 本宿主里没有它的进程(`null`:没起,或重启后还在 tmux 里等接回)也打断不了它。runtime 说不清的照算忙。
 * 与 `isAgentActive`(状态语义)不是一回事。
 */
export function busyForVersionSwitch(
  reading: Pick<AgentStatusReading, 'status'> | null,
  runtime: 'acp' | 'pty' | 'unknown',
  home: 'host' | 'tmux' | null,
): boolean {
  if (!isAgentActive(reading)) return false;
  return runtime !== 'pty' || home === 'host';
}

/** 要人来处理的是需要你或出错。一群 agent 里要人来处理的那一种,取最急的(紧急度同 agentStatusUrgency:需要你先于出错);都不要人 = null。 */
export type AgentAttention = 'needs_user' | 'error' | null;

export function mostUrgentAttention(statuses: Iterable<AgentStatus | null>): AgentAttention {
  let attention: AgentAttention = null;
  for (const status of statuses) {
    if (status === 'needs_user') return 'needs_user';
    if (status === 'error') attention = 'error';
  }
  return attention;
}

/**
 * 紧急度:需要你 > 出错 > 在跑 > 做完未读 > 空闲 > 没有状态源。
 * 多条状态汇成一个(一个任务的多条会话、一个群的多个 agent)只按它取最高 —— ❌ 在别处另排。
 */
export function agentStatusUrgency(
  reading: Pick<AgentStatusReading, 'status' | 'detail'> | null,
  unseen = false,
): number {
  if (reading === null) return 0;
  switch (reading.status) {
    case 'needs_user':
      return 5;
    case 'error':
      return 4;
    case 'working':
      return 3;
    case 'idle':
      return unseen && reading.detail === 'done' ? 2 : 1;
  }
}

/** 取最紧急的一项;平手取先出现的。 */
export function mostUrgent<T>(
  items: Iterable<T>,
  read: (item: T) => { reading: Pick<AgentStatusReading, 'status' | 'detail'> | null; unseen?: boolean },
): T | undefined {
  let best: T | undefined;
  let bestRank = -1;
  for (const item of items) {
    const { reading, unseen } = read(item);
    const rank = agentStatusUrgency(reading, unseen);
    if (rank > bestRank) {
      best = item;
      bestRank = rank;
    }
  }
  return best;
}

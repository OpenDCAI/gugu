import type { Session } from '@shared/core/sessions/sessions';
import { defineEvent } from '@shared/lib/ipc/events';
import type { AgentStatusReading } from '@gugu/core/shared/agentStatus';

export type ProviderReviewGate = 'mcp';
/** 阻塞的种类;它归哪一个活动态由 provider-review-gate.ts 的 PROVIDER_BLOCKER_STATUS 那张表决定。 */
export type ProviderBlockerReason = 'workspace-trust' | 'hook-trust' | 'auth' | 'account' | 'config';
export type ProviderBlocker = {
  kind: 'provider';
  reason: ProviderBlockerReason;
  message: string;
};

export const sessionChangedChannel = defineEvent<{
  sessionId: string;
  projectId: string;
  changes: {
    /**
     * 这条会话的 provider 会话 id。**`null` = 清空**(这条会话现在没有可续的 provider 会话)。
     *
     * ⚠️ 清空**必须**用 `null`,❌ 不能用 `undefined`:这条事件要跨两种传输,而网页宿主那条
     * 走 `JSON.stringify`(`host-ws-protocol.ts` 的 `encodeHostWsMessage`)—— 它会把值为
     * `undefined` 的键**整个丢掉**,于是「清空」在线上变成「什么都没说」,渲染端照旧留着
     * 一个已经作废的 id。Electron 那条传输(structured clone)保得住,所以这个坑**只在一种
     * 宿主上发作**,两边都不报错(#5869)。
     */
    providerSessionId?: string | null;
    /** 清掉 = 这条会话收成了普通会话(不再归某次自动化运行)。清空用 `null`,理由同上。 */
    automationRunId?: string | null;
    /**
     * 会话记录里 harness 自家那一半的模型(`config.model`)。`null` = 删了键(换成咕咕的模型 / 清回默认),理由同上。
     * 渲染层通用模式的启动路读的是它手里这份,不跟上就按旧模型起(#7092)。
     */
    model?: string | null;
    /**
     * 活会话上改过、provider 已确认的思考档位(record-live-session-setting),或从没起来过的会话换的档位。
     * `null` = 回 harness 默认,理由同上。
     */
    effort?: string | null;
    /**
     * #7342 引擎最后一次报的上下文读数(ACP 状态桥在一轮落定时写)。`null` = 作废了(换了模型),理由同上。
     * 输入框在没有活会话时画的就是渲染层手里这一份。
     */
    contextUsage?: Session['contextUsage'] | null;
    /**
     * 引擎那边有没有这条会话的持久状态(`'missing'` / `'restart_failed'`)。`null` = 去掉了(重来了 / 新开起来了,#7223),
     * 理由同上:用 `undefined` 的话网页宿主那条传输收到的是「什么都没说」,页面一直挂着「已经没有这条会话了」。
     */
    providerSessionState?: Session['providerSessionState'] | null;
  } & Partial<
    Pick<
      Session,
      | 'lastInteractedAt'
      | 'title'
      // 活会话上改过、provider 已确认的设置(record-live-session-setting)。渲染层自己的启动路
      // 读的是它手里这份 Conversation,不跟上的话重开时照旧下发建会话时那一档。
      | 'permissionMode'
      // spec session-runtime-switch:会话中途换了展示(编程 ⇄ 通用)。渲染端据此重算页签种类
      // 与整条会话的形态,❌ 不必等下一次全量拉取。
      | 'runtime'
      | 'parentSessionId'
      | 'spawnedBySessionId'
      // spec session-graph:归档/恢复只改这一行的这一个字段,渲染端据此收起或放回这一行。
      | 'archivedAt'
      | 'isPinned'
    >
  >;
}>('session:changed');

export const sessionCreatedChannel = defineEvent<{
  session: Session;
}>('session:created');

/**
 * spec agent-status-writer —— 一条会话的状态写下之后的那一份输出。写入者是它唯一的来源:进程内读者、
 * 会话页渲染层、宿主按 agent 的流拿的都是这同一个形状,❌ 各自再推导。
 */
export type AgentStatusChange = {
  sessionId: string;
  projectId: string;
  /** `null` = 这条会话没有状态源(只会出现在快照里)。 */
  reading: AgentStatusReading | null;
  /** 这一句你还没看过(做完、等人、出错时写下为未读;打开会话后已读)。 */
  unseen: boolean;
  reviewGate: ProviderReviewGate | null;
  providerBlocker: ProviderBlocker | null;
  /** 声明了的状态来源读不出时的一句原因(spec hook-status-derivation「打断边:会话在场文件」);`null` = 正常。 */
  statusSourceFault: string | null;
};

/** 哪些会话不在了(删除、归档、随项目一起走):按会话或项目圈定。 */
export type SessionScope = { sessionId: string } | { projectId: string };

/** 这条会话落在 `scope` 里吗。 */
export function sessionInScope(
  session: { sessionId: string; projectId: string },
  scope: SessionScope,
): boolean {
  if ('sessionId' in scope) return session.sessionId === scope.sessionId;
  return session.projectId === scope.projectId;
}

export const sessionAgentStatusChangedChannel = defineEvent<
  AgentStatusChange & {
    appFocused: boolean;
    soundEvent?: 'needs_attention' | 'task_complete';
  }
>('session:agent-status-changed');

/** Session-page work failed after the initiating request returned. */
export const sessionDeliveryFailedChannel = defineEvent<{
  sessionId: string;
  projectId: string;
  messageId?: string;
  message: string;
}>('session:delivery-failed');

/**
 * 会话启动时**由宿主**等着的那一步(#6183)。启动不设墙钟 ⇒ 等待要看得见:
 * 宿主开始等时发一条带 `stage` 的,等完发一条 `stage: null` 的。
 * - `checking-executable`:终端(TUI)腿的版本探针。取消走既有的 `pty.stopSession`;
 *   失败 / 取消的原文照旧由 hydrate 抛出,进启动失败账本。
 * - `preparing-adapter`:聊天(ACP)腿在等这一家配对的桥接下载完(#6394,用户的 CLI 升级后第一次)。
 *   这时 worker 还没开始起会话,聊天面板在 worker 报出自己的步骤之前显示这一步。
 */
export const sessionStartStageChannel = defineEvent<{
  sessionId: string;
  stage: 'checking-executable' | 'preparing-adapter' | null;
  /** 正在被探的可执行文件 / 正在下载的桥接(`<包>@<版本>`);`stage` 为 null 时省略。 */
  executable?: string;
  /** 这一步开始的时刻(ms);`stage` 为 null 时省略。 */
  since?: number;
}>('session:start-stage');

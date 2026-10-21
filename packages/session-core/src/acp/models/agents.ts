import { z } from 'zod';

/**
 * `lost`:重开会话(replay)时还挂着「在跑」的后台子智能体。
 *
 * `claude --resume` 起来的是一个**新进程**,老进程里的后台任务不会跟过来 —— 实测
 * (2026-09-06,CLI 2.1.259)resume 启动只吐 SessionStart 两条 hook 事件,没有任何
 * 后台任务清单;SDK 0.3.197 也没有「查在跑的任务」这个接口(`background_tasks` 那个
 * 控制请求是「把前台任务转后台」,不是列表)。所以 replay 里看到的每一次后台派发,到
 * replay 结束时若还没等到完成通知,它就已经不在跑了。owner 2026-09-06:「replay 结束时
 * 把没收到通知的后台子智能体从「在跑」里撤掉(不判成功/失败)」—— 于是它既不是
 * completed 也不是 failed,而是失联。
 */
/**
 * `stopped`:被叫停 —— 用户在面板那张卡上按了「停止」(#5117),或供应商自己停了它
 * (SDK `stop_task` → `task_notification status:'stopped'`)。既不是跑成也不是跑砸。
 */
export const agentStatusSchema = z.enum(['running', 'completed', 'failed', 'lost', 'stopped']);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/**
 * 「那个子智能体跑完了」这条通知(#4981)。
 *
 * owner 2026-09-06 定的模型:派发是**一次当场完成的工具调用**,它跑完了是**后面一条通知**
 * ——「其实无非是 toolcall 和 notification」。所以这条通知在转录里是一条真消息,
 * ❌ 不再像先前那样被吃掉、只拿去偷偷改那一行的状态。
 *
 * `toolCallId` 指回派发它的那次调用 —— 面板据此知道哪张卡该撤,不需要任何跨进程的状态。
 */
export const subagentNotificationSchema = z.object({
  /** 运行时给这个子智能体的 id。 */
  agentId: z.string(),
  /** 派发它的那次工具调用。 */
  toolCallId: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'stopped']),
  /** 供应商给的一句话总结,可能没有。 */
  summary: z.string().optional(),
  /** 它的输出落在哪个文件里,可能没有。 */
  outputFile: z.string().optional()
});
export type SubagentNotification = z.infer<typeof subagentNotificationSchema>;

export const agentStateSchema = z.object({
  /** Provider/runtime id for the spawned agent; stable across later status notifications. */
  agentId: z.string(),
  /** Tool call that launched or represents this agent in the transcript. */
  toolCallId: z.string(),
  /** Turn that launched the agent; null only for orphan updates whose launch was never observed. */
  launchTurnId: z.string().nullable(),
  name: z.string(),
  status: agentStatusSchema,
  /** Epoch ms when the runtime first observed this agent. */
  startedAt: z.number(),
  /** Epoch ms when the agent reached a terminal status. Absent while running. */
  completedAt: z.number().optional(),
  /** True for Claude-style async/background agents that can outlive their launch turn. */
  background: z.boolean().optional(),
  /** Provider-managed file containing background-agent output, when available. */
  outputFile: z.string().optional(),
  /** Provider-supplied completion summary for background-agent updates. */
  summary: z.string().optional(),
  /**
   * 谈成 `clientCapabilities.subagents` 后它自己的 ACP 会话号(#5117)。有它时
   * `toolCallId` 就等于它 —— 会话号是这个子智能体的**唯一身份**,派它出去的那次
   * Agent 调用只是别名(见 `agentToolUseId`)。没谈成时缺席。
   */
  subagentSessionId: z.string().optional(),
  /** 派它出去的那次 Agent/Task 调用的 tool_use id;子会话上的事件用它认亲(`parentToolUseId`)。 */
  agentToolUseId: z.string().optional(),
  /** 它回给主智能体的正文 —— 子会话上流回来的 agent 文本,累计。 */
  output: z.string().optional(),
  reasoning: z.string().optional(),
  canCancel: z.boolean().optional(),
  model: z.string().optional(),
  activityVersion: z.number().optional(),
});

export type AgentState = z.infer<typeof agentStateSchema>;

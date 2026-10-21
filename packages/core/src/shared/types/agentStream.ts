// ACP agent 流式输出事件（main→renderer，#966 gate A）。
//
// agent 的回合输出（session/update）在 electron 主进程的 AcpSession 上以 'update' 事件实时吐出。
// 旧 terminal 路径靠 stop-hook 抓 JSONL 文件回放，ACP 下改成把这些 chunk 直接推给 renderer 渲染。
// 转可直接渲染的子类型（文本 chunk + 终态）+ tool_call 作为**状态信号**（#1687）：tool_call 只带工具
// 名、**不带正文**，渲染端用它累计「本回合调用了几次工具」当运行态指示，绝不当聊天正文渲染（守 #1671
// 投递契约——user-visible 回复只能经 gugu_message MCP 落库）。
//
// 该类型同时被 electron 主进程（生产）、preload（桥接）、renderer（消费）引用，故落在 shared。

export type AgentStreamEvent =
  | { type: 'message_chunk'; text: string }
  | { type: 'thought_chunk'; text: string }
  // @@@1687 tool_call 状态信号：name=工具名(title/kind),renderer 计数用,不渲染为正文。
  // @@@1696 kind=ACP semantic kind(read/edit/execute/search/think…)，驱动统一运行态的流光动词(name 仍是 title 展示名)。
  | { type: 'tool_call'; name: string; kind?: string }
  | { type: 'done' }
  // #2115 commandId：普通回合(agent.deliver)终态失败时携带失败命令 id——renderer 失败条据此提供
  // 「重试」(CAS error→pending 重排原命令)。spawn 失败/进程退出等进程级 error 不带(无命令可重排)。
  | { type: 'error'; message: string; commandId?: string }

/** 一条流式事件的投递信封：哪个 agent、哪个会话、什么事件。 */
export interface AgentStreamPayload {
  agentUserId: string
  conversationId: string
  // @@@1196-q5 thread-scoped running：该流属于哪个 thread（null=主会话）。运行中/流式指示必须按
  // (conversation, thread) 隔离——否则一个 thread 跑 turn 会让所有 thread + 主视图的「运行中」全亮
  // （#957 确认的会话级外溢 bug，必须按 thread 隔离）。
  threadRootId: string | null
  event: AgentStreamEvent
}

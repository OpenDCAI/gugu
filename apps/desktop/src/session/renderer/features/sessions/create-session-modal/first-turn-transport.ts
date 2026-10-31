import { providerConsumesStartupPrompt } from '@gugu/session-core/agents/plugins';
import type { AgentCapabilities } from '@shared/core/agents/agent-payload';
import { sessionRuntimeOfView, type SessionView } from '@shared/core/sessions/sessions';

export type FirstTurnTransport = 'startup' | 'local-session';

/**
 * 会话页新建任务的首轮**这一条消息**走哪个 transport —— 这是唯一一处定义它的地方。
 * - `startup` = provider 的启动 prompt(argv/stdin 或 ACP session/prompt);
 * - `local-session` = 会话内的第一轮输入(`rpc.sessions.sendMessage`),与这条会话第二轮、第三轮同一路。
 * 两者都是会话内输入,附件按这条会话后续每一轮的编码给绝对路径 mention。
 *
 * ❌ 不由 provider 在 `sessionpage[surface].messageTransport` 里的声明决定首轮走哪条路 ——
 * 那个声明回答的是「这个 agent 能不能被 IM 寻址」,与「用户在会话页打的第一句话算不算一条 IM
 * 私聊」是两回事。混用的后果实测过:会话页建的会话,首轮被 gugu IM 的投递链路裹上 listen-mode
 * `<system_hint>` 送进终端,agent 于是以为自己在私聊里被叫到;顺带建出私聊、触发 shell 的
 * 「agent 起来了」事件,把用户从会话页拽去聊天页。
 */
export function firstTurnTransportOf(input: {
  sessionView: SessionView;
  prompt?: AgentCapabilities['prompt'] | null;
}): FirstTurnTransport {
  // 用户选的是**展示**;跑起来是哪种进程是它的后果,不是它的定义。翻译只在这一行发生,
  // 下面全用翻出来的那个词 —— ❌ 别让 `pty`/`acp` 顺着入参回流进产品层(见 sessions.ts)。
  const runtimeTransport = sessionRuntimeOfView(input.sessionView);
  // 声明了启动通道就走启动通道。`local-session` 是把字打进 pty 那一档,首句正是那一档最不可靠的
  // 时刻 —— TUI 还在起,打进去的字没人接(#4494)。有启动通道就不许下沉到它。
  // A delivery-bridge provider consumes the first turn during its host-owned startup
  // (Codex app-server / OpenCode serve). Keep that payload out of local-session, where the session
  // may be waiting for the very turn that would make it live; later messages still use the router.
  const deliveryBridgeStartup = runtimeTransport === 'pty' && input.prompt?.startupDelivery === 'delivery-bridge';
  if (input.prompt && (providerConsumesStartupPrompt(input.prompt, runtimeTransport) || deliveryBridgeStartup)) return 'startup';
  return 'local-session';
}

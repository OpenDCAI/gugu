import { providerConsumesStartupPrompt } from '@gugu/session-core/agents/plugins';
import type { AgentCapabilities } from '@shared/core/agents/agent-payload';
import {
  sessionRuntimeOfView,
  sessionpageLegOfView,
  type SessionView,
} from '@shared/core/sessions/sessions';

/**
 * 这次创建是**从哪一面发起的**(spec agent-creation:对话页「新建 Agent」留在对话页完成;
 * 会话页「新建任务」留在会话页完成)。见 `firstTurnTransportOf` 的注释了解它决定什么。
 */
export type SessionCreationSurface = 'chat-page' | 'session-page';

export type FirstTurnTransport = 'startup' | 'router' | 'local-session' | 'none';

/** Startup payload consumers must never silently choose bare text when the originating surface is absent. */
export function requireStartupOrigin(
  creationSurface: SessionCreationSurface | undefined,
): SessionCreationSurface {
  if (!creationSurface) throw new Error('startup first turn requires an explicit creation surface');
  return creationSurface;
}

/**
 * 首轮**这一条消息**走哪个 transport —— 这是唯一一处定义它的地方。
 *
 * 它同时决定这一轮的三件事,所以三件事不可能各自漂开:
 * - **正文怎么送**:`startup` = provider 的启动 prompt(argv/stdin 或 ACP session/prompt);
 *   `router` = 一条普通私聊消息(`sendMessageToChat`);
 *   `local-session` = 会话内的第一轮输入(`rpc.sessions.sendMessage`)。
 * - **附件怎么编码**(#4325):`router` 那一轮是真 IM 消息 ⇒ 附件与该 DM 里稍后任何一条附件
 *   消息完全同路(上传 chat-media → attachment 消息);其余取值那一轮是会话内输入 ⇒ 附件按这条
 *   会话后续每一轮的编码方式给绝对路径 mention。
 * - **送完去哪**:`router`、以及对话页发起的 `startup`,都原地进入新 Agent 私聊;`local-session`
 *   留在会话页。对话页的 `startup` 之所以也有私聊可进,是因为它那一句**本身就是一条真的咕咕
 *   消息**:注入器边界在会话起来之前把 DM 开好、把这条消息按 exact `initialMessageId` 落库并
 *   标记 agent 已读,再把同一份 route=chat 信封交给启动通道。⇒ 气泡天然存在、回复天然落回 DM,
 *   而模型看见的是启动那一刻的第一轮 —— ❌ 不是「先建会话再想办法把字打进去」,也 ❌ 不是
 *   「送完之后补一条消息进 DM」。
 *
 * ⚠️ **必须只有这一个表达式**。#4325 第一版把附件通道单独按 `creationSurface` 算了一遍,于是
 * 「对话页 + 关掉 Chat UI + provider 的 tui 声明 local-session」(devin/droid/cline/copilot/
 * cursor/kilocode/oh-my-pi …)那一格上,正文走会话内投递而附件仍排在 chat 通道里,发送时被整批
 * 跳过 —— 又一次静默丢。两条轴写成两个表达式就是这个 bug 的形状本身。
 *
 * ❌ 不由 provider 在 `sessionpage[surface].messageTransport` 里的声明决定**会话页**首轮走哪条路 ——
 * 那个声明回答的是「这个 agent 能不能被 IM 寻址」,与「用户在会话页打的第一句话算不算一条 IM
 * 私聊」是两回事。混用的后果实测过:会话页建的会话,首轮被 gugu IM 的投递链路裹上 listen-mode
 * `<system_hint>` 送进终端,agent 于是以为自己在私聊里被叫到;顺带建出私聊、触发 shell 的
 * 「agent 起来了」事件,把用户从会话页拽去聊天页 —— 会话页与聊天页的行为变得一模一样。
 */
export function firstTurnTransportOf(input: {
  creationSurface: SessionCreationSurface;
  sessionpage: AgentCapabilities['sessionpage'] | null | undefined;
  sessionView: SessionView;
  prompt?: AgentCapabilities['prompt'] | null;
}): FirstTurnTransport {
  // 用户选的是**展示**;跑起来是哪种进程是它的后果,不是它的定义。翻译只在这一行发生,
  // 下面全用翻出来的那个词 —— ❌ 别让 `pty`/`acp` 顺着入参回流进产品层(见 sessions.ts)。
  const runtimeTransport = sessionRuntimeOfView(input.sessionView);
  // 对话页照旧读 provider 的声明(它要的是一条真的私聊消息,provider 得能被寻址)。
  const surface = sessionpageLegOfView(input.sessionView);
  const declared = input.sessionpage?.[surface]?.messageTransport ?? 'none';
  // 声明了启动通道就走启动通道 —— 三格,同一个表达式:
  //  · 会话页:裸启动 prompt(没有私聊,也不该有)。
  //  · 对话页通用视角:同一条 `session/prompt`,在会话页注入器边界裹成 route=chat 信封。
  //  · 对话页编程视角且这条 surface 声明的是 `local-session`:同样裹成 route=chat 信封,只是载体换成
  //    provider 自己的 argv/stdin 启动槽(注入器边界是 pty hook 那一侧的孪生)。
  //    `local-session` 是**把字打进 pty** 那一档(#4500 §三 维度 2 的档 4),而首句正是那一档最不
  //    可靠的时刻 —— TUI 还在起,打进去的字没人接(#4494)。有启动通道就不许下沉到它。
  // A session-page delivery-bridge provider consumes the first turn during its host-owned startup
  // (Codex app-server / OpenCode serve). Keep that payload out of local-session, where the session
  // may be waiting for the very turn that would make it live; later messages still use the router.
  const sessionPageDeliveryBridgeStartup =
    input.creationSurface === 'session-page'
    && runtimeTransport === 'pty'
    && input.prompt?.startupDelivery === 'delivery-bridge';
  if (
    input.prompt
    && (input.creationSurface === 'session-page' || input.sessionView === 'general' || declared === 'local-session')
    && (providerConsumesStartupPrompt(input.prompt, runtimeTransport) || sessionPageDeliveryBridgeStartup)
  ) return 'startup';
  // 会话页未声明启动通道时保留会话内投递 —— 那正是这条会话第二轮、第三轮走的同一路。
  if (input.creationSurface === 'session-page') return 'local-session';
  return declared;
}

/**
 * 这一轮的附件按哪条编码走。判据是**这一轮是不是一条真的咕咕消息**,与正文同源、同一处产地:
 *  · `router` 那一轮是普通私聊消息 ⇒ 附件是同一 DM 里的 attachment 消息;
 *  · 对话页发起的 `startup` 那一轮**同样是一条真的咕咕消息**(spec delivery-routing:注入器边界按 exact
 *    `initialMessageId` 把它落进 DM),所以它的附件与这条 DM 里稍后任何一条附件消息完全同路 —— 正文随
 *    spawn 载荷走,附件是紧随其后的 attachment 行,由读者在会话 live 后投递(spec agent-create「附件与承载
 *    它的那条消息同路」)。#5049:此前这一格被判成 path-mention,对话页 + 通用视角(ACP 腿)带附件的首轮在
 *    下面的 tripwire 上响亮失败、一个 Agent 都建不出来 —— 判据本身漂了,不是 tripwire 误报。
 *  · 会话页的 `startup` / `local-session` / `none` 是会话内输入 ⇒ 按该会话后续每一轮的编码给绝对路径 mention。
 */
export function attachmentChannelOf(
  transport: FirstTurnTransport,
  creationSurface: SessionCreationSurface,
): 'chat-attachment' | 'path-mention' {
  if (transport === 'router') return 'chat-attachment';
  if (transport === 'startup' && creationSurface === 'chat-page') return 'chat-attachment';
  return 'path-mention';
}

/**
 * 这一轮排着的 chat 待发附件与它的 transport 自洽吗 —— 不自洽回一句话,自洽回 null。
 *
 * chat 待发队列只属于 `attachmentChannelOf` 判成 `chat-attachment` 的那一轮。别的取值却排着队,
 * 说明两条轴又从这个表达式漂开了 —— 那是 tripwire,不是正常出口:静默跳过整批就是 #4325 要判死的
 * 静默丢。它与它依据的那个映射写在同一个文件里,于是漂开无处可藏。
 *
 * ⚠️ 调用方必须在**建 task 之前**问一次:先建再抛会留下一个孤儿 task,而重试沿用同一个
 * PendingMessage(transport 已被快照)只会一次次走回同一条分支 —— 用户手里剩一个建好的空 task
 * 和一个按了就报错的按钮。
 */
export function strayChatAttachmentError(
  transport: FirstTurnTransport,
  pending: readonly unknown[],
  creationSurface: SessionCreationSurface,
): string | null {
  if (pending.length === 0 || attachmentChannelOf(transport, creationSurface) === 'chat-attachment') return null;
  return `${pending.length} pending chat attachment(s) on a ${transport} first turn — `
    + 'the attachment channel and the message transport disagree';
}

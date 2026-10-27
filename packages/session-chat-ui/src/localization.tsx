/** @jsxImportSource solid-js */
import { createContext, useContext } from 'solid-js';

export type ChatTranslationValues = Readonly<Record<string, string | number>>;
export type ChatTranslator = (key: string, values?: ChatTranslationValues) => string;
export type ChatTranslationSubscriber = (listener: () => void) => () => void;

/**
 * transcript 允许使用的翻译键的**权威全集**。
 *
 * 用 `satisfies` 而不是 `: Record<string, string>` 注解：注解会把键类型拓宽成 `string`，
 * 于是 `keyof typeof` 拿不到联合，任何字符串都能冒充翻译键。这正是 #3482 的成因 ——
 * 组件 prop 上一个 `label?: string` 就足以把未翻译的英文送到用户眼前，而类型、lint、测试
 * 全都不会红。
 *
 * ⚠️ 由此派生的 `ChatTranslationKey` **不是新增约束**：`defaultChatTranslator` 对不在这张表里的
 * 键本来就 throw（见下），所以这个联合恰好等于运行时已经在强制的那个集合，
 * 只是把发现时机从运行时提前到编译时。
 */
const fallbackMessages = {
  'transcript.failed': 'Failed',
  'transcript.error': 'error',
  'transcript.awaitingPermission': 'Awaiting permission',
  // 计划审批卡（#7139）：头的状态词与 Claude 那几种开始方式。
  'transcript.planReview': 'Plan',
  'transcript.planApproved': 'Approved',
  'transcript.planRejected': 'Not approved',
  'transcript.planStart': 'Start — ask before edits',
  'transcript.planStartAuto': 'Start in auto mode',
  'transcript.planStartClearAuto': 'Clear context, then start in auto mode',
  'transcript.planStartBypass': 'Start without permission prompts',
  'transcript.planStartAcceptEdits': 'Start — auto-accept edits',
  'transcript.planStartRestore': 'Start in my previous mode',
  'transcript.planKeepPlanning': 'Keep planning',
  'transcript.planRejectExit': "Don't start — leave planning",
  'transcript.working': 'Working…',
  'transcript.turnPlaceholder': 'Thinking…',
  // thinking 行头的 5 个状态。`{seconds}` 是已经算好的整秒数——
  // 秒数本身是数据，不是文案，所以计时逻辑留在组件里，这里只管怎么说这句话。
  'transcript.thinking': 'Thinking',
  'transcript.thinkingElapsed': 'Thinking {seconds}s',
  'transcript.thoughtBriefly': 'Thought briefly',
  'transcript.thoughtFor': 'Thought for {seconds}s',
  'transcript.thought': 'Thought',
  // `{name}` 是用户自己的附件文件名——原始数据，不翻译，只被这句话包住。
  'transcript.outputTrimmed': '{chars} characters omitted from this preview; the original record is unchanged.',
  'transcript.imageUnavailable': 'Image unavailable. Click to retry.',
  'transcript.viewImage': 'View image: {name}',
  'transcript.viewAttachment': 'Open attachment: {name}',
  'transcript.copy': 'Copy',
  'transcript.copyCode': 'Copy code',
  'transcript.copyMessage': 'Copy message',
  'transcript.copied': 'Copied',
  // 附件卡(#7193):agent 打开给人看的文件 / 网页。`{name}` 是文件名或网址,原样数据。
  'transcript.outputDocument': 'Document',
  'transcript.outputImage': 'Image',
  'transcript.outputPage': 'Web page',
  'transcript.outputWebPreview': 'Web preview',
  'transcript.outputWebsite': 'Website',
  'transcript.outputOpenLabel': 'Open {name}',
  'transcript.outputOpenWith': 'Ways to open {name}',
  'transcript.read': 'Read',
  'transcript.edited': 'Edited',
  'transcript.editedFile': 'Edited {name}',
  'transcript.editedFiles': 'Edited {count} files',
  'transcript.expandFiles': 'Show files',
  'transcript.collapseFiles': 'Hide files',

  'transcript.deleted': 'Deleted',
  'transcript.moved': 'Moved',
  'transcript.files': '{count} files',
  'transcript.execute': 'Execute',
  // execute 行的收尾读数。`{code}` / `{signal}` 是数据不是文案，所以格式化留在组件里，
  // 这里只管怎么把这个读数说成一句话。信号那条独立成键，因为被信号杀死与自己退出是
  // 两件事，把 SIGTERM 塞进 "exit {code}" 会读成一个不存在的退出码。
  'transcript.exitCode': 'exit {code}',
  'transcript.exitSignal': 'signal {signal}',
  'transcript.search': 'Search',
  'transcript.mcp': 'MCP',
  'transcript.fetch': 'Fetch',
  'transcript.subagent': 'Subagent',
  // 转录里这一行是 tool call 形态:一个动词 + 它干了什么(owner 2026-09-05)。
  'transcript.subagentSpawn': 'Launch subagent',
  'transcript.tool': 'Tool',
  'transcript.background': '{name} (background)',
  'transcript.spawning': 'Spawning',
  'transcript.running': 'Running',
  'transcript.completed': 'Completed',
  'transcript.failedPhase': 'Failed',
  'transcript.turnCancelled': 'Turn cancelled{reason}',
  'transcript.turnFailed': 'Turn failed{reason}',
  'transcript.turnCompleted': 'Turn completed{reason}',
  'transcript.turnProcess': 'Process',
  'transcript.turnElapsed': 'Worked for {elapsed}',
  'transcript.turnTook': 'Took {elapsed}',
  'transcript.copyTurnResult': 'Copy turn record',
  // 同一行的两副面孔（#4981 #12）：跑着的时候是这一句 + 微光，落定后是上面那一句。
  // 连续工具调用折成的一句（#4981，owner 2026-09-06）：各类一个短语，单数 / 复数各一键
  // （英文 `1 pattern` / `3 patterns` 不能靠一个模板），用 `join` 串起来。首字母大写由代码做。
  'transcript.toolRun.join': ', ',
  'transcript.toolRun.thinkingOne': 'thought {count} time',
  'transcript.toolRun.thinking': 'thought {count} times',
  'transcript.toolRun.searchOne': 'searched for {count} pattern',
  'transcript.toolRun.search': 'searched for {count} patterns',
  'transcript.toolRun.readOne': 'read {count} file',
  'transcript.toolRun.read': 'read {count} files',
  'transcript.toolRun.editOne': 'edited {count} file',
  'transcript.toolRun.edit': 'edited {count} files',
  'transcript.toolRun.executeOne': 'ran {count} shell command',
  'transcript.toolRun.execute': 'ran {count} shell commands',
  'transcript.toolRun.fetchOne': 'fetched {count} page',
  'transcript.toolRun.fetch': 'fetched {count} pages',
  'transcript.toolRun.mcpOne': 'called {count} MCP tool',
  'transcript.toolRun.mcp': 'called {count} MCP tools',
  'transcript.toolRun.subagentLaunchOne': 'launched {count} subagent',
  'transcript.toolRun.subagentLaunch': 'launched {count} subagents',
  'transcript.toolRun.subagentDoneOne': '{count} subagent finished',
  'transcript.toolRun.subagentDone': '{count} subagents finished',
  'transcript.toolRun.subagentStoppedOne': '{count} subagent stopped',
  'transcript.toolRun.subagentStopped': '{count} subagents stopped',
  'transcript.toolRun.commandDoneOne': '{count} background command finished',
  'transcript.toolRun.commandDone': '{count} background commands finished',
  'transcript.toolRun.commandStoppedOne': '{count} background command stopped',
  'transcript.toolRun.commandStopped': '{count} background commands stopped',
  'transcript.toolRun.planOne': 'updated the plan {count} time',
  'transcript.toolRun.plan': 'updated the plan {count} times',
  'transcript.toolRun.toolOne': 'used {count} tool',
  'transcript.toolRun.tool': 'used {count} tools',
  'transcript.planProgress': 'Plan · {done} of {total} done',
  // agent 经 message_send / session_message 说的话,下面那一行去向(agent-send.def)。
  'transcript.agentSendTo': 'Sent to {chat}',
  'transcript.agentSendToChat': 'Sent to a chat',
  'transcript.agentSendToThreadIn': 'Sent to a thread in {chat}',
  'transcript.agentSendToThread': 'Sent to a thread',
  'transcript.agentSendWhisperIn': 'Whispered in {chat}',
  'transcript.agentSendWhisper': 'Whispered',
  'transcript.agentSendToSession': 'Sent to another task',
  'transcript.agentSendToSessions': 'Sent to {count} tasks',
  'transcript.agentSending': 'sending…',
  'transcript.deliveryViaChat': 'via chat',
  'transcript.deliveryViaGroup': 'via group {chat}',
  'transcript.deliveryViaUnnamedGroup': 'via a group',
  'transcript.deliveryFromMe': 'You',
  'transcript.questionAnswered': 'You answered: {answer}',
  'transcript.questionWithdrawn': 'You withdrew the question',
  'transcript.deliveryWhisper': 'whisper',
  'transcript.deliveryViaApp': 'from app {app}',
  'transcript.deliveryViaSession': 'from a task',
  'transcript.deliveryViaExtension': 'from an App',
  'transcript.deliveryViaForum': 'from the forum',
  'transcript.deliveryFromGugu': 'from 咕咕',
  'transcript.deliveryScheduled': 'scheduled, due now',
  'transcript.deliveryScheduledTitled': 'scheduled “{title}”, due now',
  'transcript.deliveryDetails': 'Details',
  'transcript.deliveryReplyTo': 'Replying to {from}: {preview}',
  'transcript.deliveryUnknownSender': 'Delivered via 咕咕',
  'transcript.deliveryLegacySender': 'Delivered via 咕咕',
  'transcript.deliveryFact.at': 'Time',
  'transcript.deliveryFact.sender': 'Sender',
  'transcript.deliveryFact.route': 'Route',
  'transcript.deliveryFact.thread': 'Thread',
  'transcript.deliveryFact.message': 'Message',
  'transcript.deliveryFact.listen': 'Listening',
  'transcript.deliveryFact.then': 'Then',
  'transcript.deliveryFact.replyTo': 'In reply to',
  'transcript.deliveryFact.threadContext': 'Thread context',
  'transcript.deliveryFact.messageContext': 'Message context',
  'transcript.deliveryFact.whisperTo': 'Whisper to',
  'transcript.deliveryFact.viaApp': 'App',
  'transcript.turnFinished': 'Turn finished{reason}',
  'transcript.viewMermaid': 'View Mermaid diagram',
  'transcript.mermaidDiagram': 'Mermaid diagram',
  'transcript.mermaidError': "Couldn't render diagram",
  'transcript.stopGenerating': 'Stop generating',
  'transcript.editMessage': 'Edit message',
  'transcript.cancelEdit': 'Cancel',
  'transcript.sendEdit': 'Send',
  // turn-outcome 的动作（#3498）。文案必须与它真做的事逐字相同：它**只**把指令放回输入框。
  // ❌ 不许改成 Retry / Try again / 继续 —— 那三个词在本仓后端都没有对应能力
  //（证据链见 turn-outcome.def.tsx 顶部），换上去按钮就开始骗人。
  'transcript.restorePrompt': 'Restore prompt',
  'transcript.restorePromptHint': 'Put this prompt back in the composer (it is not re-sent)',
  // turn-outcome 的失败原因（#3498）。**纯描述，不含行动建议** ——
  // 这 11 个 reason 都没有「重试」这条路（同上），所以文案只说发生了什么；
  // 用户能拿到的那一件事由上面那个按钮说，不由原因文案暗示。
  'transcript.reasonPromptFailed': 'the turn could not be completed',
  'transcript.reasonSignInRequired': 'sign-in needed',
  'transcript.reasonProcessClosed': 'the agent process ended',
  'transcript.reasonSpawnFailed': 'the agent process could not start',
  'transcript.reasonInitializeFailed': 'the agent did not finish initializing',
  'transcript.reasonNewSessionFailed': 'a new session could not be opened',
  'transcript.reasonLoadSessionFailed': 'the existing session could not be loaded',
  'transcript.reasonCancelFailed': 'the stop request was not accepted',
  'transcript.reasonSetConfigFailed': 'the configuration could not be applied',
  'transcript.reasonSetModeFailed': 'the mode could not be changed',
  'transcript.reasonCancelledByUser': 'you stopped this turn',
  'transcript.reasonInterruptedForMessage': 'paused to take a new message',
  'transcript.continueTurn': 'Continue',
  'transcript.continueTurnHint': 'Ask the agent to pick up where it stopped (sends a new prompt)',
  'transcript.discardTurn': 'Discard',
  'transcript.discardTurnHint': 'Drop the half-written answer from this view (the agent still remembers it)',
  // 日界分隔行（#3334 第 20 行）。只有这两个相对日名需要翻译 —— 再往前的日期是
  // 由 date-fns 按与 React chrome 面 `absolute-time.tsx` 相同的 pattern 排出来的
  // 数据，不是文案。`{day}` 是已经排好的那句话，这里只把它包成可读的无障碍名字。
  'transcript.today': 'Today',
  'transcript.yesterday': 'Yesterday',
  'transcript.dayStart': 'Start of {day}',
  // 上下文压缩的界线（spec session-history-replay）。措辞要说清**后果**，不是说清机制：
  // 用户要判断的是「上面那些话它还记不记得原文」，❌ 不是「压缩算法跑过了」。
  'transcript.compacting': 'Compacting context…',
  'transcript.compacted': 'Context compacted — the agent keeps a summary of everything above',
  'transcript.compactionFailed': 'Context compaction failed',
  'transcript.contextReset': "The engine started a new session — it doesn't have the earlier messages",
  'transcript.sessionNotice.modelUnavailable':
    'The model this task was created with is unavailable here — running {running} instead',
  'transcript.sessionNotice.modelSubstituted': 'The engine is running {running}, not the model picked',
  'transcript.sessionNotice.modelUnavailableDefault':
    'The model this task was created with is unavailable here — running the engine default instead',
  'transcript.sessionNotice.modelSubstitutedUnknown': 'The engine is not running the model picked',
  'transcript.sessionNotice.effortUnavailable':
    'The reasoning level picked is not accepted by this model — running {running} instead',
  // #6396 会话起来时的名字在登记时已经用过(序号只增不减)⇒ 换成了下一个。行上只说「用过了」:
  // 多数是另一台设备先用了,但刚开 app 一秒内建的会话也可能撞上以前删掉的号,❌ 不断言是哪一种。
  'transcript.sessionNotice.agentRenamed': '{previous} is now {running} — that name had already been used',
  'transcript.condition.harnessMissing': 'This engine is not installed yet',
  'transcript.condition.harnessUpdating': 'The engine is updating — it will be back in a few seconds',
  'transcript.condition.authRequired': 'Sign in to keep going',
  'transcript.condition.providerSessionMissing': 'The engine no longer has this session',
  'transcript.condition.providerSessionMissingWithHistory':
    'The engine no longer has this session — everything above is still here',
  'transcript.condition.adapterLost': 'Lost the connection to the engine',
  'transcript.condition.startFailed': 'The engine could not start',
  'transcript.condition.machineUnreachable': "Can't reach the machine this task runs on",
  'transcript.condition.machineAttention': 'The machine this task runs on needs attention',
  'transcript.condition.membershipRequired': 'This Gugu model needs a membership',
  'transcript.hookNoticeFrom': 'from the {hook} hook',
  'transcript.hookNoticeLevel.notice': 'Notice',
  'transcript.hookNoticeLevel.suggestion': 'Suggestion',
  'transcript.hookNoticeLevel.warning': 'Warning',
  'transcript.subagentDone': 'subagent finished',
  'transcript.subagentFailed': 'subagent failed',
  'transcript.subagentStopped': 'subagent stopped',
  'transcript.commandDone': 'background command finished',
  'transcript.commandFailed': 'background command failed',
  'transcript.commandStopped': 'background command stopped',
} satisfies Record<string, string>;

/**
 * transcript 组件可以使用的翻译键。用于收紧**组件 prop**（如 `CopyButton` 的 `labelKey`），
 * 让调用点传英文字面量在**编译期**就被拒收。
 *
 * ❌ 刻意**不**用它收紧 `ChatTranslator` 的 `key` —— 那是宿主注入的公开契约，宿主 catalog 是
 * 这张 fallback 表的超集（见 `apps/desktop/.../localization/messages.ts`），收紧它会波及所有宿主，
 * 且运行时并没有在强制"键必须来自 fallback"这件事。⇒ 收紧发生在 prop 一侧，不在契约一侧。
 */
export type ChatTranslationKey = keyof typeof fallbackMessages;

export const defaultChatTranslator: ChatTranslator = (key, values = {}) => {
  // 故意用宽索引：`key` 是 `string`（宿主契约，见 ChatTranslationKey 的注释），
  // 这个函数必须能接受任意串并对未知键 throw —— 下一行那个 throw 就是运行时约束本体。
  // ⚠️ 去掉上面的 `satisfies` 改回注解会让这里"看起来不需要 cast"，但那是把口子重新打开。
  const template = (fallbackMessages as Record<string, string>)[key];
  if (!template) throw new Error(`Missing session-chat-ui translation: ${key}`);
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Missing session-chat-ui translation value: ${key}:${name}`);
    return String(value);
  });
};

const ChatTranslationContext = createContext<ChatTranslator>(defaultChatTranslator);

export const ChatTranslationProvider = ChatTranslationContext.Provider;

export function useChatTranslator(): ChatTranslator {
  return useContext(ChatTranslationContext);
}

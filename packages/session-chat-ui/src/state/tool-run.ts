/**
 * 连续的工具调用折成**一句话**（#4981，owner 2026-09-06）。
 *
 * owner 原话：「所有的都是 tool call，除了文本消息，连续的 tool call 可以被折叠……比如
 * 我所看到的 claudecode，这些动作都会被折叠为语义上的一句话：Searched for 1 pattern,
 * ran 2 shell commands / Searched for 3 patterns, read 2 files, listed 1 directory,
 * ran 12 shell commands。文本消息和 edit 不折叠。」
 *
 * 这里只做三件纯函数的事：一条行**能不能**进同一段（`toolRunCategory`）、一段里各类
 * 各有几条（`tallyToolRun`）、把计数说成一句（`toolRunLabel`）。切段与展开由 flatten 做。
 *
 * ## 什么进段、什么切段
 *
 *  · 进段：**思考** / 读文件 / 搜索 / **改文件**（建 / 改 / 删、diff）/ 跑命令 / 抓网页 / MCP /
 *    派子智能体 / 子智能体跑完 / 计划 / 其它工具。它们是「过程」，读者要的是**做了多少**，
 *    不是每一条。owner 2026-09-06 后来把改文件也收了进来：「除了 ai 文本以外都语义化折叠吧，
 *    他的语义类似于编辑了几次文件」（先前那句「文本消息和 edit 不折叠」由此作废）。
 *    owner 2026-10-16 又把思考收了进来：「短暂思考其实也是可以折叠的……压缩成一段话」——
 *    它夹在一串命令中间，每一行都把「跑了 N 条命令」劈开，一屏全是「短暂思考 / 执行」交替（#7316）。
 *  · 切段：文本消息 —— 那是 agent 在说话，不是过程。经 message_send / session_message 说出去的那段话同理
 *    (`agentSendOf`):群里派的任务,agent 的话都是这么回的,折进「调用了 N 个 MCP 工具」就一个字也看不到了。
 *
 * ❌ 不按「N 条以上才折」之外的任何启发式：一条就是一行（折一条等于把一行换成另一行，
 * 没意义）；两条起折。
 */
import { toolCallName } from '@gugu/session-core/acp/client';
import { isQuestionOrPlanToolName } from '@gugu/session-core/session-record/question-tools';
import { agentSendOf } from '@gugu/session-core/session-record/reply-process';
import type { ChatItem, TranscriptItem } from '@session-chat/model';
import type { ChatTranslator } from '@session-chat/localization';
import { executeCommandChipText } from '@session-chat/components/rows/tools/execute/execute.layout';

export type ToolRunCategory =
  | 'thinking'
  | 'search'
  | 'read'
  | 'edit'
  | 'execute'
  | 'fetch'
  | 'mcp'
  | 'subagentLaunch'
  | 'subagentDone'
  | 'subagentStopped'
  | 'commandDone'
  | 'commandStopped'
  | 'plan'
  | 'tool';

/** 各类的先后 = 句子里的先后。与 owner 举的例子同序：搜索 → 读 → 改 → 命令；思考在最前（先想后做）。 */
const CATEGORY_ORDER: readonly ToolRunCategory[] = [
  'thinking',
  'search',
  'read',
  'edit',
  'execute',
  'fetch',
  'mcp',
  'subagentLaunch',
  'subagentDone',
  'subagentStopped',
  'commandDone',
  'commandStopped',
  'plan',
  'tool',
];

/** 这一行属于哪一类；`null` = 它不进段（文本），并把前面的段切断。 */
export function toolRunCategory(item: ChatItem, conversation = false): ToolRunCategory | null {
  switch (item.kind) {
    case 'thinking':
      return 'thinking';
    case 'search-tool-call':
      return 'search';
    case 'read-tool-call':
      return 'read';
    case 'patch-tool-call':
    case 'diff':
      return 'edit';
    case 'file-op':
      // 一组文件操作:读的归读,建/改/删/移的归改。
      return item.op === 'read' ? 'read' : 'edit';
    case 'create-plan-tool-call':
    case 'plan':
      return 'plan';
    case 'execute-tool-call':
      return 'execute';
    case 'web-fetch-tool-call':
      return 'fetch';
    case 'mcp-tool-call':
      return !conversation && agentSendOf(item as TranscriptItem) ? null : 'mcp';
    case 'tool':
      return conversation ? 'tool' : null;
    case 'spawn-subagent-tool-call':
      return 'subagentLaunch';
    case 'subagent-done-tool-call':
      // 被叫停的(卡上的「停止」,#5117)单独成一格 —— 「跑完了」是它没有的结局。
      return item.outcome === 'stopped' ? 'subagentStopped' : 'subagentDone';
    case 'background-command-done-tool-call':
      return item.outcome === 'stopped' ? 'commandStopped' : 'commandDone';
    case 'unknown-tool-call':
      // 提问 / 计划批准是读者自己的一步，不并进「用了 N 个工具」（同 turn-fold 的 isQuestionCall）。
      return isQuestionOrPlanToolName(toolCallName(item)) ? null : 'tool';
    case 'tool-group':
      return 'tool';
    default:
      // message(agent 在说话)以及宿主自己的旧式 chat 行(tool / execute / subagent)
      return null;
  }
}

export type ToolRunTally = Partial<Record<ToolRunCategory, number>>;

export function tallyToolRun(items: readonly ChatItem[], conversation = false): ToolRunTally {
  const tally: ToolRunTally = {};
  for (const item of items) {
    // `tool-group` is a layout wrapper (for example the read-batch emitted for
    // three adjacent reads), not a tool call of its own. Counting the wrapper
    // as `tool` produced summaries such as "ran 3 commands, used 1 tool" even
    // though the hidden children were all file reads. Walk the leaves so the
    // sentence reports the same calls that expansion reveals.
    if (item.kind === 'tool-group') {
      const childTally = tallyToolRun(item.children, conversation);
      for (const category of CATEGORY_ORDER) {
        const count = childTally[category];
        if (!count) continue;
        tally[category] = (tally[category] ?? 0) + count;
      }
      continue;
    }
    const category = toolRunCategory(item, conversation);
    if (!category) continue;
    tally[category] = (tally[category] ?? 0) + 1;
  }
  return tally;
}

const ONE_KEYS: Record<ToolRunCategory, string> = {
  thinking: 'transcript.toolRun.thinkingOne',
  search: 'transcript.toolRun.searchOne',
  read: 'transcript.toolRun.readOne',
  edit: 'transcript.toolRun.editOne',
  execute: 'transcript.toolRun.executeOne',
  fetch: 'transcript.toolRun.fetchOne',
  mcp: 'transcript.toolRun.mcpOne',
  subagentLaunch: 'transcript.toolRun.subagentLaunchOne',
  subagentDone: 'transcript.toolRun.subagentDoneOne',
  subagentStopped: 'transcript.toolRun.subagentStoppedOne',
  commandDone: 'transcript.toolRun.commandDoneOne',
  commandStopped: 'transcript.toolRun.commandStoppedOne',
  plan: 'transcript.toolRun.planOne',
  tool: 'transcript.toolRun.toolOne',
};

const MANY_KEYS: Record<ToolRunCategory, string> = {
  thinking: 'transcript.toolRun.thinking',
  search: 'transcript.toolRun.search',
  read: 'transcript.toolRun.read',
  edit: 'transcript.toolRun.edit',
  execute: 'transcript.toolRun.execute',
  fetch: 'transcript.toolRun.fetch',
  mcp: 'transcript.toolRun.mcp',
  subagentLaunch: 'transcript.toolRun.subagentLaunch',
  subagentDone: 'transcript.toolRun.subagentDone',
  subagentStopped: 'transcript.toolRun.subagentStopped',
  commandDone: 'transcript.toolRun.commandDone',
  commandStopped: 'transcript.toolRun.commandStopped',
  plan: 'transcript.toolRun.plan',
  tool: 'transcript.toolRun.tool',
};

/**
 * 「思考了 2 次、搜索了 3 个模式、读了 2 个文件、跑了 12 条命令」。
 *
 * 每类一个短语（单数 / 复数各一个键 —— 英文 `1 pattern` / `3 patterns` 不能靠一个模板），
 * 用词表里的连接词串起来（en `, `、zh `、`），首字母大写 —— 中文没有大小写，这一步是空操作。
 */
export function toolRunLabel(tally: ToolRunTally, translate: ChatTranslator): string {
  const parts: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const count = tally[category];
    if (!count) continue;
    const key = count === 1 ? ONE_KEYS[category] : MANY_KEYS[category];
    parts.push(translate(key, { count }));
  }
  const joined = parts.join(translate('transcript.toolRun.join'));
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * 跑着的这一段此刻在做什么:一句计数只说做了多少,一轮只想、只跑命令不说话时,能动的只剩数字和计时,
 * 看着就是卡住了(会话卡死录像,10-27)。有一条在跑的命令 ⇒ 那条命令(命令片段与执行行同一个读法);
 * 正在想 ⇒ 思考;都没有 ⇒ null,这一句照旧。跑完的段没有在跑的行,自然恢复原样。
 * ❌ 不露思考的内容:网关回来的思考块只有签名、正文是空的。桌面 tool-run 与手机 ProcessRun 读这一份。
 */
export type ToolRunNow = { kind: 'command'; command: string } | { kind: 'thinking' };

export function toolRunNow(items: readonly ChatItem[]): ToolRunNow | null {
  let thinking = false;
  const visit = (rows: readonly ChatItem[]): ToolRunNow | null => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const item = rows[i] as ChatItem;
      if (item.kind === 'tool-group') {
        const inner = visit(item.children as readonly ChatItem[]);
        if (inner) return inner;
        continue;
      }
      const status = 'status' in item ? (item as { status?: string }).status : undefined;
      if ((item.kind === 'execute-tool-call' || item.kind === 'execute') && status === 'running') {
        const command = executeCommandChipText(item as Parameters<typeof executeCommandChipText>[0]);
        if (command) return { kind: 'command', command };
      }
      if (item.kind === 'thinking' && status === 'thinking') thinking = true;
    }
    return null;
  };
  return visit(items) ?? (thinking ? { kind: 'thinking' } : null);
}

/** 那一句后面接的半句(「正在跑」/「在思考」);命令片段由行自己用等宽字画在它后面。 */
export function toolRunNowLabel(now: ToolRunNow, translate: ChatTranslator): string {
  return translate(now.kind === 'command' ? 'transcript.toolRun.nowRunning' : 'transcript.toolRun.nowThinking');
}

/**
 * Item-level fold: NormalizedEvent -> TranscriptItem[].
 *
 * foldItem applies one NormalizedEvent to an existing item list and returns
 * the updated list. The fold materializes streaming ACP updates into concrete
 * turn-owned models: messages, thinking segments, tool-call items, and
 * deterministic tool groups.
 *
 * finalizeItems settles all in-progress states for a turn that has just been
 * committed (thinking done + durationMs, running tool/group -> done).
 *
 * Both functions are pure and allocation-efficient: only changed items are
 * replaced; unchanged items are returned by reference.
 */

import { SESSION_PLAN_ID } from '../models/plan';
import type { TerminalExit } from '../models/terminals';
import type {
  CreateFileToolCall,
  CreatePlanToolCall,
  ModifyFileToolCall,
  ReadToolCall,
  TranscriptCompaction,
  TranscriptContextReset,
  TranscriptSessionNotice,
  TranscriptItem,
  TranscriptMessage,
  TranscriptThinking,
  ToolCallItem,
  ToolGroup,
  ToolImage,
  ToolNode,
  ToolStatus,
} from '../models/turns';
import {
  makeCompactionId,
  makeContextResetId,
  makeSessionNoticeId,
  makeDiffId,
  makeMessageId,
  makePlanId,
  makeThinkingId,
  makeToolGroupId,
  makeToolId,
} from './ids';
import type {
  NormalizedDiff,
  NormalizedEvent,
  NormalizedToolLocation,
  NormalizedToolStatus,
} from './normalized-event';

export type FoldEvent =
  | Exclude<NormalizedEvent, { kind: 'message' | 'thinking' }>
  | (Extract<NormalizedEvent, { kind: 'message' }> & { messageId: string })
  | (Extract<NormalizedEvent, { kind: 'thinking' }> & { messageId: string });

function mapToolStatus(status: NormalizedToolStatus | null | undefined): ToolStatus | undefined {
  switch (status) {
    case 'pending':
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    default:
      return undefined;
  }
}

/** 有没有真的说出一个字 —— 空串和只有空白都不算。 */
function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function isToolCallItem(item: TranscriptItem): item is ToolCallItem {
  return item.kind.endsWith('-tool-call');
}

function isToolGroup(item: TranscriptItem): item is ToolGroup {
  return item.kind === 'tool-group';
}

function isSubagentKind(toolKind: string | null | undefined): boolean {
  return toolKind === 'subagent' || toolKind === 'task' || toolKind === 'agent';
}

function isSearchKind(toolKind: string | null | undefined): boolean {
  return toolKind === 'search' || toolKind === 'grep';
}

function isReadKind(toolKind: string | null | undefined, title?: string | null): boolean {
  return toolKind === 'read' || toolKind === 'read_file' || title?.startsWith('Read ') === true;
}

/**
 * ACP 的 `delete` 档(协议枚举里有,`node_modules/@agentclientprotocol/sdk` 的 ToolKind)。
 *
 * gugu 早就有 `delete-file-tool-call` 这个 kind、file-op 行族也早就画得出它
 * （`file-op.def.tsx` 的 `deleteFileOpFromItem`、`unit-registry.ts` 里也登记了）——
 * **只是没有任何地方产出它**（改造前全仓 0 处）。于是一次删除掉进 unknown,行上只剩一个
 * 原始函数名。这是 #4981 里第五次遇到同一个形状:**字段有、UI 读、产品路径没人填**。
 */
function isDeleteKind(toolKind: string | null | undefined): boolean {
  return toolKind === 'delete' || toolKind === 'delete_file';
}

function isExecuteKind(toolKind: string | null | undefined): boolean {
  return toolKind === 'execute' || toolKind === 'terminal' || toolKind === 'bash';
}

function isMcpToolKind(toolKind: string | null | undefined): boolean {
  return toolKind === 'mcp-tool' || toolKind === 'mcp_tool';
}

/**
 * 按**名字**认出一次 MCP 调用,并把它拆成 server + tool。
 *
 * 为什么不能只看 `toolKind`:上面那个 `isMcpToolKind` 要的 `'mcp-tool'` / `'mcp_tool'`
 * **不在 ACP 的 kind 枚举里**(那份枚举是 read/edit/delete/move/search/execute/think/
 * fetch/switch_mode/other)。走 ACP 的 agent 因此永远命中不了它,每一次 MCP 调用都掉进
 * `unknown-tool-call`,行上印出一整条 `mcp__playwright__browser_navigate`。
 * 真机验收截图里就是这个样子(owner,2026-09-05)。
 *
 * `mcp__<server>__<tool>` 是这些宿主给 MCP 工具起名的约定,名字本身就带着分解所需的
 * 全部信息。⚠️ 只在名字**真的**长这样时才认:对不上就老老实实留在 unknown,
 * ❌ 不猜 —— 把一个普通工具错认成 MCP 会凭空造出一个不存在的 server 名。
 */
function parseMcpToolName(title: string): { server: string; tool: string } | null {
  if (!title.startsWith('mcp__')) return null;
  const rest = title.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

function isWebFetchKind(toolKind: string | null | undefined): boolean {
  return toolKind === 'web-fetch' || toolKind === 'web_fetch' || toolKind === 'fetch';
}

function compareSeq(a: { seq: number }, b: { seq: number }): number {
  return a.seq - b.seq;
}

function stripChildren<T extends ToolCallItem>(item: T): T {
  if (!item.children?.length) return item;
  const { children: _children, ...withoutChildren } = item;
  return withoutChildren as T;
}

function flattenItems(items: TranscriptItem[]): TranscriptItem[] {
  const flat: TranscriptItem[] = [];
  const visit = (item: TranscriptItem | ToolNode): void => {
    if (isToolGroup(item)) {
      for (const child of item.children) visit(child);
      return;
    }
    if (isToolCallItem(item)) {
      flat.push(stripChildren(item));
      for (const child of item.children ?? []) visit(child);
      return;
    }
    flat.push(item);
  };
  for (const item of items) visit(item);
  return flat.sort(compareSeq);
}

function maxSeq(items: TranscriptItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.seq), -1);
}

function nextSeq(items: TranscriptItem[]): number {
  return maxSeq(items) + 1;
}

/** Payload fields every tool kind carries, independent of which renderer claims it. */
type ToolPayloadFields = {
  /** 供应商自己的工具名(标题是显示名时);见 BaseToolCallItem。 */
  toolName?: string;
  rawInput?: string;
  rawOutput?: string;
  outputText?: string;
  /** 工具交回来的图;见 BaseToolCallItem。 */
  images?: ToolImage[];
  /** 这次调用留下的后台任务 id(#5117);见 BaseToolCallItem。 */
  backgroundTaskId?: string;
  /** 那个后台任务的完成通知到了(#5117)。 */
  backgroundTaskDone?: true;
};

function toolPayloadFields(params: ToolPayloadFields): ToolPayloadFields {
  return {
    ...(params.toolName !== undefined ? { toolName: params.toolName } : {}),
    ...(params.rawInput !== undefined ? { rawInput: params.rawInput } : {}),
    ...(params.rawOutput !== undefined ? { rawOutput: params.rawOutput } : {}),
    ...(params.outputText !== undefined ? { outputText: params.outputText } : {}),
    ...(params.images !== undefined ? { images: params.images } : {}),
    ...(params.backgroundTaskId !== undefined ? { backgroundTaskId: params.backgroundTaskId } : {}),
    ...(params.backgroundTaskDone !== undefined
      ? { backgroundTaskDone: params.backgroundTaskDone }
      : {}),
  };
}

function baseToolFields(
  id: string,
  seq: number,
  toolCallId: string,
  title: string,
  status: NormalizedToolStatus | null,
  parentToolCallId: string | undefined,
  inputSummary?: string
): Omit<ToolCallItem, 'kind'> {
  return {
    id,
    seq,
    toolCallId,
    title,
    status: mapToolStatus(status) ?? 'running',
    ...(inputSummary !== undefined ? { inputSummary } : {}),
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
  };
}

export function createToolCallItem(params: {
  id: string;
  seq: number;
  toolCallId: string;
  title: string;
  toolKind: string | null;
  status: NormalizedToolStatus | null;
  parentToolCallId: string | undefined;
  inputSummary?: string;
  toolName?: string;
  rawInput?: string;
  rawOutput?: string;
  outputText?: string;
  images?: ToolImage[];
  backgroundTaskId?: string;
  backgroundTaskDone?: true;
  terminalId?: string;
  exitStatus?: TerminalExit;
  locations: ReadonlyArray<NormalizedToolLocation>;
  /**
   * 这条调用是什么时候到的(墙钟)。目前只有子智能体那一支要它 —— 卡上那句「跑了多久」
   * 从它算起。
   *
   * ⚠️ 子智能体条目有**两条**创建路径:`upsertSpecialEvent` 那条(供应商报了 Agent/Task
   * 工具名)一直在写 `startedAt`,而这一条(按 `toolKind` 认出来的)先前不写 ⇒ 走到这儿的
   * 那些卡时长恒是 `0s`,而进度条靠步数算、看着还挺满,于是「跑了很久」和「刚起」长得一样。
   * owner 2026-09-06 截图里四张卡全是 0s,就是这一条。
   */
  startedAt?: number;
}): ToolCallItem {
  const base = {
    ...baseToolFields(
      params.id,
      params.seq,
      params.toolCallId,
      params.title,
      params.status,
      params.parentToolCallId,
      params.inputSummary
    ),
    ...toolPayloadFields(params),
  };
  const { title, toolKind } = params;
  if (isSubagentKind(toolKind)) {
    return {
      kind: 'spawn-subagent-tool-call',
      ...base,
      name: title,
      ...(params.startedAt !== undefined ? { startedAt: params.startedAt } : {}),
    };
  }
  if (isSearchKind(toolKind)) {
    return { kind: 'search-tool-call', ...base, query: title };
  }
  if (isMcpToolKind(toolKind)) {
    return { kind: 'mcp-tool-call', ...base, tool: title };
  }
  // 按名字认(见 parseMcpToolName):ACP 那侧永远给不出 mcp 这个 kind,
  // 不这么认的话每次 MCP 调用都只剩一条原始函数名。
  const mcp = parseMcpToolName(title);
  if (mcp) {
    return { kind: 'mcp-tool-call', ...base, server: mcp.server, tool: mcp.tool };
  }
  if (isWebFetchKind(toolKind)) {
    return { kind: 'web-fetch-tool-call', ...base, url: title };
  }
  if (isReadKind(toolKind, title)) {
    const path = params.locations[0]?.path;
    return {
      kind: 'read-tool-call',
      ...base,
      ...(path !== undefined ? { path } : {}),
    };
  }
  if (isDeleteKind(toolKind)) {
    const path = params.locations[0]?.path;
    // ⚠️ 没有路径就**不认**:`DeleteFileToolCall.path` 是必填的,硬塞一个空串等于在行上
    // 摆一个不存在的文件名。宁可留在 unknown —— 那一行至少还说得出自己叫什么。
    if (path !== undefined) {
      return { kind: 'delete-file-tool-call', ...base, path };
    }
  }
  if (isExecuteKind(toolKind)) {
    return {
      kind: 'execute-tool-call',
      ...base,
      command: title,
      ...(params.terminalId !== undefined ? { terminalId: params.terminalId } : {}),
      ...(params.exitStatus !== undefined ? { exitStatus: params.exitStatus } : {}),
    };
  }
  return { kind: 'unknown-tool-call', ...base, toolKind, name: title };
}

function updateToolCallItem(
  item: ToolCallItem,
  title: string | null,
  status: NormalizedToolStatus | null,
  payload: ToolPayloadFields,
  locations: ReadonlyArray<NormalizedToolLocation> | null | undefined,
  terminalId?: string,
  exitStatus?: TerminalExit,
  parentToolCallId?: string
): ToolCallItem {
  const mapped = mapToolStatus(status ?? undefined);
  const nextTitle = title ?? item.title;
  // 归属只会**补上**,不会丢掉。
  //
  // ⚠️ 一次子调用的结果回来时,适配器发**两条** `tool_call_update`:先到的那条带
  // `toolResponse` 却**不带** `parentToolUseId`,后到的那条才带(实机 2026-09-06:
  // WebSearch 42 条带 / 21 条不带,顺序恒是不带的在前)。跨轮时先到的那条会在新一轮
  // 里建出一个没有归属的条目 —— 而这个函数先前根本不接归属,后到的那条再也补不回来。
  // 后果就是那条子调用掉回主消息列表,拼成 owner 截图里那面墙。
  // ❌ 反过来不许:已经认了爹就不许被一条空的更新改判。
  const nextParent = item.parentToolCallId ?? parentToolCallId;
  // ⚠️ 这个联合类型里只有子智能体那一支有 `startedAt`,直接 `item.startedAt` 收窄不出来。
  const priorStartedAt: number | undefined =
    'startedAt' in item && typeof item.startedAt === 'number' ? item.startedAt : undefined;

  // 还没认出来的调用,等真名字到了要**重新分类**(#4981)。
  //
  // ACP 允许 `tool_call_update` 先于 `tool_call` 到达,也允许它不带 title。那种情况下
  // 这条调用会以「不认识」的身份被建出来,而下面的 switch 只改字段、**不改 kind** ——
  // 于是身份在第一条事件那一刻就被永久冻住了。真机上的两个症状同出一源:
  //   · `mcp__playwright__browser_navigate` 显示的是后来更新进来的真名字,
  //     但 kind 还是 unknown,所以永远不会被拆成 server + tool;
  //   · 没等到名字的那几行,直接把占位串 `unknown` 摆给了用户看。
  //
  // 只对 `unknown-tool-call` 做,且只在**名字真的变了**的时候:已经认出身份的调用
  // 不该因为一次普通更新就改换门庭,那会让一行在读者眼皮底下变成另一种东西。
  if (item.kind === 'unknown-tool-call' && title !== null && title !== item.title) {
    const reclassified = createToolCallItem({
      id: item.id,
      seq: item.seq,
      toolCallId: item.toolCallId,
      title,
      toolKind: item.toolKind,
      status,
      parentToolCallId: nextParent,
      // ⚠️ 重分类沿用老条目的起点,❌ 不重置 —— 重置一次卡上的时长就往回跳。
      ...(typeof priorStartedAt === 'number' ? { startedAt: priorStartedAt } : {}),
      ...(item.inputSummary !== undefined ? { inputSummary: item.inputSummary } : {}),
      ...toolPayloadFields(payload),
      ...(terminalId !== undefined ? { terminalId } : {}),
      ...(exitStatus !== undefined ? { exitStatus } : {}),
      locations: locations ?? [],
    });
    // 仍旧不认识就走原路 —— ❌ 不要用一个新造的 unknown 覆盖掉已经攒下的字段。
    if (reclassified.kind !== 'unknown-tool-call') {
      return { ...item, ...reclassified } as ToolCallItem;
    }
  }
  // Payload lands on `common`, so a later update carries request/result onto
  // every kind rather than only the one kind that happens to render it today.
  const common = {
    ...item,
    ...(mapped !== undefined ? { status: mapped } : {}),
    ...(title !== null ? { title: title } : {}),
    ...(nextParent !== undefined ? { parentToolCallId: nextParent } : {}),
    ...toolPayloadFields(payload),
  };
  switch (item.kind) {
    case 'execute-tool-call':
      return {
        ...common,
        ...(title !== null ? { command: nextTitle } : {}),
        ...(terminalId !== undefined ? { terminalId } : {}),
        // Only ever written, never cleared: the exit arrives on the completing
        // update and later updates for the same call do not carry it again.
        ...(exitStatus !== undefined ? { exitStatus } : {}),
      };
    case 'read-tool-call': {
      const readCommon = common as ReadToolCall;
      if (locations === undefined) return readCommon;
      if (locations?.[0] !== undefined) return { ...readCommon, path: locations[0].path };
      const { path: _path, ...withoutPath } = readCommon;
      return withoutPath;
    }
    case 'create-file-tool-call':
      return common;
    case 'modify-file-tool-call':
      return common;
    case 'delete-file-tool-call':
      return common;
    case 'search-tool-call':
      return { ...common, ...(title !== null ? { query: nextTitle } : {}) };
    case 'mcp-tool-call': {
      // ⚠️ 更新也要**重新拆**一次名字(#4981)。
      //
      // 这一行原本写的是 `tool: nextTitle` —— 那是 `tool` 只可能等于整条标题的年代留下的。
      // 现在建行时已经按 `mcp__<server>__<tool>` 拆开了,而 ACP 后续每条 `tool_call_update`
      // 都会再把完整标题送一遍 ⇒ 第一条事件拆对,第二条原样盖回去。真机上量到的就是这个
      // 半成品:`mcp-omnisearch.mcp__mcp-omnisearch__ai_search`(2026-09-05)——
      // server 是对的,tool 又变回了裸名字,正好是 owner 报的那句「mcp 怎么还是裸的」。
      //
      // 拆不开就照旧原样放 `tool`:名字不长那样的时候不猜,与建行时同一条规矩。
      const parsed = title !== null ? parseMcpToolName(nextTitle) : null;
      return {
        ...common,
        ...(parsed !== null
          ? { server: parsed.server, tool: parsed.tool }
          : title !== null
            ? { tool: nextTitle }
            : {}),
      };
    }
    case 'web-fetch-tool-call':
      return { ...common, ...(title !== null ? { pageTitle: nextTitle } : {}) };
    case 'spawn-subagent-tool-call':
    case 'subagent-done-tool-call':
    case 'background-command-done-tool-call':
      return { ...common, ...(title !== null ? { name: nextTitle } : {}) };
    case 'create-plan-tool-call':
      return common;
    case 'unknown-tool-call':
      return { ...common, ...(title !== null ? { name: nextTitle } : {}) };
  }
}

function upsertToolCallItem(items: TranscriptItem[], next: ToolCallItem): TranscriptItem[] {
  const idx = items.findIndex((item) => isToolCallItem(item) && item.id === next.id);
  if (idx >= 0) return items.map((item, i) => (i === idx ? next : item));
  return [...items, next];
}

function upsertSpecialEvent(
  items: TranscriptItem[],
  event: Extract<NormalizedEvent, { kind: 'subagent' | 'search' | 'mcp_tool' | 'web_fetch' }>,
  turnId: string,
  at: number
): TranscriptItem[] {
  const id = makeToolId(turnId, event.toolCallId);
  const existing = items.find(
    (item): item is ToolCallItem => isToolCallItem(item) && item.id === id
  );
  const seq = existing?.seq ?? nextSeq(items);
  const parentToolCallId = event.parentToolCallId ?? undefined;
  const mapped = mapToolStatus(event.status) ?? 'running';

  let next: ToolCallItem;
  switch (event.kind) {
    case 'subagent': {
      // ⚠️ 先摊开上一版,再让这条事件覆盖它带来的那几格。
      //
      // 这一支原来每次都**从头重建**条目,于是「字段缺席」被当成了「字段被清空」——
      // 而 ACP 的约定恰恰相反(见 normalized-event 里 locations 那条:undefined = 保持不变)。
      // 真机后果:claude 的首条 tool_call 带 `rawInput: {}`,派活的描述在随后的
      // tool_call_update 才到,而**完成**那条又不带 rawInput ⇒ enrich 算出的
      // inputSummary 是 undefined,把先前那句描述抹掉。行上就只剩一句「Agent 已完成」,
      // 并行派几个就是几行一模一样的(owner 验收 2026-09-05,一屏 8 行)。
      const prior = existing?.kind === 'spawn-subagent-tool-call' ? existing : undefined;
      // ⚠️ 一条**说不出话**的事件不许立起一行:没名字、也没描述。已经有行了就照旧更新
      // 它;还没有行就**不要建**。
      //
      // ⚠️ `agentId` **不算凭据**——它是内部 id,claude 自己在工具结果里就写着
      // 「internal ID - do not mention to user」。拿它立一行,行上只能显示一个通用词,
      // 对读者等于什么都没说。我第一版把 agentId 也算成凭据,真机上那 13 行空行就是
      // 从这儿漏过去的(2026-09-05 实测:那一轮 claude 的会话日志里只有 4 次 Agent 调用)。
      //
      // owner 真机 2026-09-05:并行派 4 个子任务,4 行正确的下面又摞了 9 行空的
      // 「子智能体 已完成」——没有片、没有小箭头、没有名字。落定重载后消失,因为那些
      // 只在流式过程里出现的更新事件不会被重放。并行派几个就摞几行,正是最初那个
      // 「N 行一模一样」的形状换了张脸。
      //
      // ⚠️ 这**不是**「更新先于创建到达」那种情形 —— 那种带着 title,照建不误
      // (`tool-coverage-4981` 里「update 先到、名字后补」守着)。
      if (prior === undefined && !hasText(event.title) && !hasText(event.inputSummary)) {
        return items;
      }
      next = {
        ...(prior ?? {}),
        kind: 'spawn-subagent-tool-call',
        id,
        seq,
        toolCallId: event.toolCallId,
        // ⚠️ 名字也照「缺席 = 保持不变」办,理由与下面 inputSummary 那段同源:
        // claude 的末条事件不带 title,无条件写进来就会把第二条带来的真名字盖掉。
        // 从头到尾都没有名字时留空串 —— 行映射那层会落到「子智能体」,
        // ❌ 不在这里编一个,编出来的词分不清是供应商给的还是我们造的。
        title: event.title ?? prior?.title ?? '',
        name: event.title ?? prior?.name ?? '',
        // 第一次见到它才记起点;之后的更新事件不许覆盖,否则进度条会被每条更新推回原点。
        startedAt: prior?.startedAt ?? at,
        status: mapped,
        ...(event.inputSummary !== undefined ? { inputSummary: event.inputSummary } : {}),
        ...(event.background !== undefined ? { background: event.background } : {}),
        ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
        ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
        ...(event.subagentSessionId !== undefined ? { subagentSessionId: event.subagentSessionId } : {}),
        ...(event.canCancel !== undefined ? { canCancel: event.canCancel } : {}),
        ...(event.outputText !== undefined ? { outputText: event.outputText } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      };
      break;
    }
    case 'search':
      next = {
        kind: 'search-tool-call',
        id,
        seq,
        toolCallId: event.toolCallId,
        title: event.query,
        query: event.query,
        status: mapped,
        ...(event.matchCount !== undefined ? { matchCount: event.matchCount } : {}),
        ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      };
      break;
    case 'mcp_tool':
      next = {
        kind: 'mcp-tool-call',
        id,
        seq,
        toolCallId: event.toolCallId,
        title: event.tool,
        tool: event.tool,
        status: mapped,
        ...(event.server !== undefined ? { server: event.server } : {}),
        ...(event.inputSummary !== undefined ? { inputSummary: event.inputSummary } : {}),
        ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      };
      break;
    case 'web_fetch':
      next = {
        kind: 'web-fetch-tool-call',
        id,
        seq,
        toolCallId: event.toolCallId,
        title: event.title ?? event.url,
        url: event.url,
        status: mapped,
        ...(event.title !== undefined ? { pageTitle: event.title } : {}),
        ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      };
      break;
  }

  return normalizeToolStructure(upsertToolCallItem(items, next), turnId);
}

/**
 * Auto-finalize any open thinking rows when a non-thinking content event
 * arrives. Mirrors the renderer's applyFinalizeOpenThinking behavior.
 */
function finalizeOpenThinking(items: TranscriptItem[], now: number): TranscriptItem[] {
  let changed = false;
  const result = items.map((item) => {
    if (item.kind === 'thinking' && item.status === 'thinking') {
      changed = true;
      return {
        ...item,
        status: 'done' as const,
        durationMs: now - item.startedAt,
      } satisfies TranscriptThinking;
    }
    return item;
  });
  return changed ? result : items;
}

function upsertFileOperations(
  items: TranscriptItem[],
  toolId: string,
  toolCallId: string,
  /** Null = the update leaves the title unchanged (ACP: an omitted field is unchanged). */
  title: string | null,
  parentToolCallId: string | undefined,
  diffs: NormalizedDiff[],
  status: NormalizedToolStatus | null
): TranscriptItem[] {
  // 差异行的 id 是 `makeDiffId(toolId, path)`,与工具行自己的 `toolId` **不是同一个**
  // ⇒ 两者会并存成重复的两行。改造前是靠「edit 类一律不建工具行」躲开这件事的,代价是
  // 差异没到时那次调用整个看不见(#4981,owner 2026-09-05「担心有 tool 不渲染」)。
  // 现在改成:照常建行,差异一到就把那行占位赶走 —— 可见性与不重复两头都要。
  const placeholder = items.find((it) => isToolCallItem(it) && it.id === toolId) as ToolCallItem | undefined;
  let result = items.filter((it) => !(isToolCallItem(it) && it.id === toolId));
  for (const d of diffs) {
    const id = makeDiffId(toolId, d.path);
    const mapped = mapToolStatus(status);
    const idx = result.findIndex((it) => isToolCallItem(it) && it.id === id);
    const base = {
      id,
      seq: nextSeq(result),
      toolCallId,
      title: title ?? placeholder?.title ?? 'Edit file',
      path: d.path,
      status: mapped ?? 'running',
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
    };
    if (idx >= 0) {
      const existing = result[idx] as ToolCallItem;
      const updated: ToolCallItem =
        d.oldText === null
          ? ({
              ...existing,
              kind: 'create-file-tool-call',
              content: d.newText,
              path: d.path,
              title: title ?? existing.title,
              toolCallId,
              ...(mapped !== undefined ? { status: mapped } : {}),
              ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
            } satisfies CreateFileToolCall)
          : ({
              ...existing,
              kind: 'modify-file-tool-call',
              oldText: d.oldText,
              newText: d.newText,
              path: d.path,
              title: title ?? existing.title,
              toolCallId,
              ...(mapped !== undefined ? { status: mapped } : {}),
              ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
            } satisfies ModifyFileToolCall);
      result = result.map((it, i) => (i === idx ? updated : it));
    } else if (d.oldText === null) {
      result = [
        ...result,
        {
          kind: 'create-file-tool-call',
          ...base,
          content: d.newText,
        } satisfies CreateFileToolCall,
      ];
    } else {
      result = [
        ...result,
        {
          kind: 'modify-file-tool-call',
          ...base,
          oldText: d.oldText,
          newText: d.newText,
        } satisfies ModifyFileToolCall,
      ];
    }
  }
  return result;
}

function updateFileOperationStatuses(
  items: TranscriptItem[],
  toolCallId: string,
  status: NormalizedToolStatus | null
): TranscriptItem[] {
  const mapped = mapToolStatus(status);
  if (mapped === undefined) return items;
  return items.map((item): TranscriptItem => {
    switch (item.kind) {
      case 'create-file-tool-call':
      case 'modify-file-tool-call':
      case 'delete-file-tool-call':
        return item.toolCallId === toolCallId ? { ...item, status: mapped } : item;
      default:
        return item;
    }
  });
}

function hasFileOperationsForToolCall(items: TranscriptItem[], toolCallId: string): boolean {
  return items.some((item) => {
    switch (item.kind) {
      case 'create-file-tool-call':
      case 'modify-file-tool-call':
      case 'delete-file-tool-call':
        return item.toolCallId === toolCallId;
      default:
        return false;
    }
  });
}

function planStatus(entries: Extract<NormalizedEvent, { kind: 'plan' }>['entries']): ToolStatus {
  return entries.some((entry) => entry.status === 'in_progress') ? 'running' : 'done';
}

function upsertPlanToolCall(
  items: TranscriptItem[],
  turnId: string,
  event: Extract<NormalizedEvent, { kind: 'plan' }>
): TranscriptItem[] {
  const id = makePlanId(turnId);
  const idx = items.findIndex((it) => it.kind === 'create-plan-tool-call' && it.id === id);
  const next: CreatePlanToolCall = {
    kind: 'create-plan-tool-call',
    id,
    seq: idx >= 0 ? items[idx].seq : nextSeq(items),
    toolCallId: id,
    title: 'Plan updated',
    status: planStatus(event.entries),
    planId: SESSION_PLAN_ID,
  };
  if (idx >= 0) {
    const existing = items[idx] as CreatePlanToolCall;
    return items.map((item, i) =>
      i === idx
        ? {
            ...existing,
            status: next.status,
            title: next.title,
            planId: next.planId,
          }
        : item
    );
  }
  return [...items, next];
}

function nodeStatus(node: ToolNode): ToolStatus {
  return node.status;
}

function readGroupStatus(children: ToolNode[]): ToolStatus {
  if (children.some((child) => nodeStatus(child) === 'running')) return 'running';
  if (children.some((child) => nodeStatus(child) === 'error')) return 'error';
  return 'done';
}

function wrapReadGroups<T extends TranscriptItem | ToolNode>(items: T[]): Array<T | ToolGroup> {
  return wrapRuns(items, 'read-tool-call', 'read-batch');
}

/** 把**连续的**同类调用收成一个 group;不足两个就原样放回。 */
function wrapRuns<T extends TranscriptItem | ToolNode>(
  items: T[],
  runKind: ToolNode['kind'],
  groupKind: ToolGroup['groupKind']
): Array<T | ToolGroup> {
  const result: Array<T | ToolGroup> = [];
  for (let i = 0; i < items.length; ) {
    const item = items[i];
    if (item.kind !== runKind) {
      result.push(item);
      i += 1;
      continue;
    }

    const run: ToolNode[] = [item as unknown as ToolNode];
    let j = i + 1;
    while (j < items.length && items[j].kind === runKind) {
      run.push(items[j] as unknown as ToolNode);
      j += 1;
    }

    if (run.length > 1) {
      result.push({
        kind: 'tool-group',
        id: makeToolGroupId(run[0].id),
        seq: run[0].seq,
        label: `${run.length} file reads`,
        groupKind,
        status: readGroupStatus(run),
        children: run,
      });
    } else {
      result.push(item);
    }
    i = j;
  }
  return result;
}

function buildTree(flatItems: TranscriptItem[], turnId: string): TranscriptItem[] {
  const toolById = new Map<string, ToolCallItem>();
  const childrenByParent = new Map<string, ToolCallItem[]>();
  const topLevel: TranscriptItem[] = [];

  for (const item of flatItems) {
    if (isToolCallItem(item)) {
      toolById.set(item.id, stripChildren(item));
    }
  }

  for (const item of flatItems) {
    if (!isToolCallItem(item)) {
      topLevel.push(item);
      continue;
    }

    const parentItemId =
      item.parentToolCallId !== undefined ? makeToolId(turnId, item.parentToolCallId) : undefined;
    if (parentItemId !== undefined && toolById.has(parentItemId)) {
      const children = childrenByParent.get(parentItemId) ?? [];
      children.push(stripChildren(item));
      childrenByParent.set(parentItemId, children);
    } else {
      topLevel.push(stripChildren(item));
    }
  }

  const attachChildren = (item: ToolCallItem): ToolCallItem => {
    const rawChildren = childrenByParent.get(item.id);
    if (!rawChildren?.length) return stripChildren(item);

    const children = wrapReadGroups(rawChildren.map(attachChildren).sort(compareSeq)) as ToolNode[];
    return { ...stripChildren(item), children };
  };

  const attached = topLevel.map(
    (item): TranscriptItem => (isToolCallItem(item) ? attachChildren(item) : item)
  );

  return wrapReadGroups(attached.sort(compareSeq)) as TranscriptItem[];
}

function normalizeToolStructure(items: TranscriptItem[], turnId: string): TranscriptItem[] {
  return buildTree(flattenItems(items), turnId);
}

/**
 * Apply one NormalizedEvent to a turn's item list, returning an updated list.
 * The turnId is used for id synthesis — all item ids are scoped to the turn.
 *
 * Content-bearing events (message, tool, diff, plan) auto-finalize any open
 * thinking rows before appending (the agent has moved past the reasoning phase).
 */
export function foldItem(
  items: TranscriptItem[],
  event: FoldEvent,
  turnId: string,
  at: number,
  /**
   * 真实的墙上时钟,**回放时缺席**(见 `transcriptMessageSchema.at`)。与 `at` 分开传是
   * 因为 `at` 在回放时仍要用来算工具行的时长等相对量,而写进条目的绝对时刻不能是回放的钟。
   */
  stampAt?: number
): TranscriptItem[] {
  const flatItems = flattenItems(items);
  switch (event.kind) {
    case 'message': {
      const id = makeMessageId(turnId, event.messageId, event.role);
      const base = finalizeOpenThinking(flatItems, at);
      const idx = base.findIndex((it) => it.kind === 'message' && it.id === id);
      if (idx >= 0) {
        // Append chunk to existing message.
        const msg = base[idx] as TranscriptMessage;
        const updated: TranscriptMessage = {
          ...msg,
          text: msg.text + event.text,
          ...(event.revertAnchor ? { revertAnchor: event.revertAnchor } : {}),
          ...(event.attachments?.length
            ? { attachments: [...(msg.attachments ?? []), ...event.attachments] }
            : {}),
        };
        return normalizeToolStructure(
          base.map((it, i) => (i === idx ? updated : it)),
          turnId
        );
      }
      // New message.
      const newMsg: TranscriptMessage = {
        kind: 'message',
        id,
        seq: nextSeq(base),
        role: event.role,
        text: event.text,
        ...(event.attachments?.length ? { attachments: event.attachments } : {}),
        ...(event.revertAnchor ? { revertAnchor: event.revertAnchor } : {}),
        // 只在**新建**这条消息时写:它说的是这条消息什么时候开始到的,后面的分片不该把它往后推。
        ...(stampAt !== undefined ? { at: stampAt } : {}),
      };
      return normalizeToolStructure([...base, newMsg], turnId);
    }

    case 'thinking': {
      const id = makeThinkingId(turnId, event.messageId);
      const idx = flatItems.findIndex(
        (it) => it.kind === 'thinking' && it.id === id && it.status === 'thinking'
      );
      if (idx >= 0) {
        const th = flatItems[idx] as TranscriptThinking;
        return normalizeToolStructure(
          flatItems.map((it, i) => (i === idx ? { ...th, text: th.text + event.text } : it)),
          turnId
        );
      }
      const newThinking: TranscriptThinking = {
        kind: 'thinking',
        id,
        seq: nextSeq(flatItems),
        segmentId: event.messageId,
        text: event.text,
        status: 'thinking',
        startedAt: at,
      };
      return normalizeToolStructure([...finalizeOpenThinking(flatItems, at), newThinking], turnId);
    }

    /**
     * 上下文压缩的那一条痕迹（spec `session-history-replay`）。同一次压缩的续报按
     * `compactionId` 落回同一行:`in_progress` 立行,`completed`/`failed` 就地改状态,
     * 摘要分块往上接。❌ 不新开行 —— 一次压缩在界面上只能是一条线。
     */
    case 'compaction': {
      const id = makeCompactionId(turnId, event.compactionId);
      const base = finalizeOpenThinking(flatItems, at);
      const idx = base.findIndex((it) => it.kind === 'compaction' && it.id === id);
      if (idx >= 0) {
        const row = base[idx] as TranscriptCompaction;
        const updated: TranscriptCompaction = {
          ...row,
          // 没带状态的是补数更新(token 数),❌ 不许拿它把 completed 改回 in_progress。
          ...(event.status !== undefined ? { status: event.status } : {}),
          // 终报带的摘要是**权威版**(RFD: "authoritative final replacement"),覆盖流式拼的那份;
          // 不带就保留已经拼好的,❌ 别把它清空。
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
          // 开场那条只报「在压」,token 数要等终报才有 ⇒ 一律「有才盖」,
          // ❌ 别无条件展开 event,那会把开场已经记下的字段抹成 undefined。
          ...(event.trigger !== undefined ? { trigger: event.trigger } : {}),
          ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
          ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(event.error !== undefined ? { error: event.error } : {}),
        };
        return normalizeToolStructure(
          base.map((it, i) => (i === idx ? updated : it)),
          turnId
        );
      }
      const row: TranscriptCompaction = {
        kind: 'compaction',
        id,
        seq: nextSeq(base),
        compactionId: event.compactionId,
        status: event.status ?? 'in_progress',
        summary: event.summary ?? '',
        startedAt: at,
        ...(event.trigger !== undefined ? { trigger: event.trigger } : {}),
        ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
        ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      };
      return normalizeToolStructure([...base, row], turnId);
    }

    case 'compaction_summary_chunk': {
      const id = makeCompactionId(turnId, event.compactionId);
      const idx = flatItems.findIndex((it) => it.kind === 'compaction' && it.id === id);
      // 摘要先于边界到达是不该发生的顺序;真发生了就丢弃这一块,
      // ❌ 别凭一块摘要凭空立一条「压缩过」——那会在没压缩的会话上画出一条线。
      if (idx < 0) return items;
      const row = flatItems[idx] as TranscriptCompaction;
      return normalizeToolStructure(
        flatItems.map((it, i) => (i === idx ? { ...row, summary: row.summary + event.text } : it)),
        turnId
      );
    }

    /**
     * 引擎接不上、已替这条会话开了一条新的。一条会话的一次重开只画一条线 ——
     * 重复推送落回同一行,❌ 不叠成两条。
     */
    case 'context_reset': {
      const id = makeContextResetId(turnId);
      const base = finalizeOpenThinking(flatItems, at);
      if (base.some((it) => it.kind === 'context-reset' && it.id === id)) {
        return normalizeToolStructure(base, turnId);
      }
      const row: TranscriptContextReset = {
        kind: 'context-reset',
        id,
        seq: nextSeq(base),
        reason: event.reason,
        at: stampAt ?? at,
      };
      return normalizeToolStructure([...base, row], turnId);
    }

    /**
     * 这条会话的运行条件出了事（模型没了 / 模型被换了），但会话照常开
     * （spec `session-always-openable`）。同一件事只画一行，重复推送落回同一行 ——
     * 与 `context_reset` 同一个约定，❌ 不叠成两条。
     */
    case 'session_notice': {
      const base = finalizeOpenThinking(flatItems, at);
      // 供应商提示每来一次是一件事(停了两条命令就是两行)⇒ id 带序号,❌ 按 code 并成一行。
      const id = event.code === 'provider-notice'
        ? `${makeSessionNoticeId(turnId, event.code)}:${nextSeq(base)}`
        : makeSessionNoticeId(turnId, event.code);
      if (base.some((it) => it.kind === 'session-notice' && it.id === id)) {
        return normalizeToolStructure(base, turnId);
      }
      const row: TranscriptSessionNotice = {
        kind: 'session-notice',
        id,
        seq: nextSeq(base),
        code: event.code,
        detail: event.detail,
        ...(event.effectiveValue !== undefined ? { effectiveValue: event.effectiveValue } : {}),
        ...(event.previousValue !== undefined ? { previousValue: event.previousValue } : {}),
        ...(event.title !== undefined ? { title: event.title } : {}),
        at: stampAt ?? at,
      };
      return normalizeToolStructure([...base, row], turnId);
    }

    case 'tool_call': {
      const toolId = makeToolId(turnId, event.toolCallId);
      const parentToolCallId = event.parentToolCallId ?? undefined;
      const base = finalizeOpenThinking(flatItems, at);
      if (event.diffs.length > 0) {
        const next = upsertFileOperations(
          base,
          toolId,
          event.toolCallId,
          event.title,
          parentToolCallId,
          event.diffs,
          event.status
        );
        return normalizeToolStructure(next, turnId);
      }

      // ⚠️ 这里曾经是 `if (isEditKind(...)) return base` —— 一次还没产出差异的编辑
      // **整个不渲染**:跑着的时候看不见,失败了也看不见(实测 edit + status=failed
      // 一条条目都不留)。差异一到,`upsertFileOperations` 会把这一行换掉,所以照常建。
      const tool = createToolCallItem({
        id: toolId,
        seq: nextSeq(base),
        toolCallId: event.toolCallId,
        title: event.title,
        toolKind: event.toolKind,
        status: event.status,
        parentToolCallId,
        ...(event.inputSummary !== undefined ? { inputSummary: event.inputSummary } : {}),
        ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
        ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
        ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
        ...(event.outputText !== undefined ? { outputText: event.outputText } : {}),
        ...(event.images !== undefined ? { images: event.images } : {}),
        ...(event.backgroundTaskId !== undefined
          ? { backgroundTaskId: event.backgroundTaskId }
          : {}),
        ...(event.terminalId !== undefined ? { terminalId: event.terminalId } : {}),
        ...(event.exitStatus !== undefined ? { exitStatus: event.exitStatus } : {}),
        locations: event.locations,
        // 卡上那句「跑了多久」从这里算起(见 createToolCallItem 的 startedAt)。
        startedAt: at,
      });
      const next = upsertToolCallItem(base, tool);
      return normalizeToolStructure(next, turnId);
    }

    case 'tool_update': {
      const toolId = makeToolId(turnId, event.toolCallId);
      const parentToolCallId = event.parentToolCallId ?? undefined;
      const base = finalizeOpenThinking(flatItems, at);
      if (event.diffs.length > 0) {
        const next = upsertFileOperations(
          base,
          toolId,
          event.toolCallId,
          event.title,
          parentToolCallId,
          event.diffs,
          event.status
        );
        return normalizeToolStructure(next, turnId);
      }

      const idx = base.findIndex((it) => isToolCallItem(it) && it.id === toolId);
      let next: TranscriptItem[];
      if (idx >= 0) {
        const tool = base[idx] as ToolCallItem;
        const updated = updateToolCallItem(
          tool,
          event.title,
          event.status,
          {
            ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
        ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
            ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
            ...(event.outputText !== undefined ? { outputText: event.outputText } : {}),
            ...(event.images !== undefined ? { images: event.images } : {}),
            ...(event.backgroundTaskId !== undefined
              ? { backgroundTaskId: event.backgroundTaskId }
              : {}),
            ...(event.backgroundTaskDone !== undefined
              ? { backgroundTaskDone: event.backgroundTaskDone }
              : {}),
          },
          event.locations,
          event.terminalId,
          event.exitStatus,
          parentToolCallId
        );
        next = base.map((it, i) => (i === idx ? updated : it));
      } else if (hasFileOperationsForToolCall(base, event.toolCallId)) {
        // 差异行已经在了,它们才是这次编辑的主体 —— 不要再另起一行。
        next = base;
      } else {
        next = upsertToolCallItem(
          base,
          createToolCallItem({
            id: toolId,
            seq: nextSeq(base),
            toolCallId: event.toolCallId,
            // ❌ 不写 'unknown':那是内部占位,真机上直接以「unknown」四个字母
            // 出现在了行标题里(owner 2026-09-05)。留空串,由展示层退回通用「工具」。
            title: event.title ?? '',
            toolKind: event.toolKind,
            status: event.status,
            parentToolCallId,
            ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
        ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
            ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
            ...(event.outputText !== undefined ? { outputText: event.outputText } : {}),
            ...(event.images !== undefined ? { images: event.images } : {}),
            ...(event.backgroundTaskId !== undefined
              ? { backgroundTaskId: event.backgroundTaskId }
              : {}),
            ...(event.backgroundTaskDone !== undefined
              ? { backgroundTaskDone: event.backgroundTaskDone }
              : {}),
            ...(event.terminalId !== undefined ? { terminalId: event.terminalId } : {}),
            ...(event.exitStatus !== undefined ? { exitStatus: event.exitStatus } : {}),
            locations: event.locations ?? [],
            startedAt: at,
          })
        );
      }

      next = updateFileOperationStatuses(next, event.toolCallId, event.status);
      return normalizeToolStructure(next, turnId);
    }

    case 'subagent':
    case 'search':
    case 'mcp_tool':
    case 'web_fetch': {
      const base = finalizeOpenThinking(flatItems, at);
      return upsertSpecialEvent(base, event, turnId, at);
    }

    case 'subagent_done': {
      // owner 2026-09-06:「子智能体运行完你就当 toolcall 渲染就行了」——
      // 派发一行、跑完另一行,两行都是工具调用。
      //
      // ⚠️ 这一行的 `toolCallId` 是**通知自己的**(`task-notification:<派发 id>`),
      // ❌ 不复用派发那次调用的 id:复用了 fold 会把它认成同一次调用的更新,
      // 「跑完了」又变回对派发行的一次状态改写 —— 那正是 owner 否掉的模型。
      const base = finalizeOpenThinking(flatItems, at);
      const toolCallId = `task-notification:${event.toolCallId}`;
      const id = makeToolId(turnId, toolCallId);
      const existing = base.find(
        (item): item is ToolCallItem => isToolCallItem(item) && item.id === id
      );
      const next: ToolCallItem = {
        ...(existing?.kind === 'subagent-done-tool-call' ? existing : {}),
        kind: 'subagent-done-tool-call',
        id,
        seq: existing?.seq ?? nextSeq(base),
        toolCallId,
        launchToolCallId: event.toolCallId,
        agentId: event.agentId,
        // 名字由 reducer 从登记册查好塞进来;查不到就空串,行上落到通用词,❌ 不编。
        title: event.name ?? '',
        name: event.name ?? '',
        // 通知到了,这次「调用」就完成了 —— 跑成/跑砸是它带回来的内容,写在 outcome 里。
        // ❌ 不写成 status:'error':通用工具行会为它打 ❌,而行名已经说了「子智能体失败」
        // (owner 2026-09-06)。
        // 说「还在跑」的通知(供应商允许同一 task 通知多次)这一行也还在跑 —— 面板那张卡
        // 靠它判要不要撤(见 subagent-roster `collectNotified`)。
        status:
          event.status === 'completed' || event.status === 'failed' || event.status === 'stopped'
            ? 'done'
            : 'running',
        outcome:
          event.status === 'failed' ? 'failed' : event.status === 'stopped' ? 'stopped' : 'completed',
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        // 它回给主智能体的正文(#5117):这一行是「它跑完了」这次调用,正文就是这次调用的
        // 结果 —— 通用工具行展开后按 `outputText` 显示,与别的工具调用同一形态。
        ...(event.outputText !== undefined ? { outputText: event.outputText } : {}),
        ...(event.outputFile !== undefined ? { outputFile: event.outputFile } : {}),
      };
      return normalizeToolStructure(upsertToolCallItem(base, next), turnId);
    }

    case 'background_command_done': {
      // 「后台命令跑完了」与「子智能体跑完了」同一形态:自己一行,❌ 不复用命令卡的 id
      // (复用了就变回对命令卡的一次状态改写)。同一条命令的终态可能来两次(`stopped` 暂定后被
      // `completed` 纠正),按 id 合并,后到的赢。
      const base = finalizeOpenThinking(flatItems, at);
      const toolCallId = `command-done:${event.toolCallId}`;
      const id = makeToolId(turnId, toolCallId);
      const existing = base.find(
        (item): item is ToolCallItem => isToolCallItem(item) && item.id === id
      );
      const next: ToolCallItem = {
        ...(existing?.kind === 'background-command-done-tool-call' ? existing : {}),
        kind: 'background-command-done-tool-call',
        id,
        seq: existing?.seq ?? nextSeq(base),
        toolCallId,
        launchToolCallId: event.toolCallId,
        title: event.name,
        name: event.name,
        // 通知到了,这次「调用」就完成了;跑成/跑砸写在 outcome 里(与 subagent-done 同一约定)。
        status: 'done',
        outcome: event.outcome,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      } as ToolCallItem;
      return normalizeToolStructure(upsertToolCallItem(base, next), turnId);
    }

    case 'plan': {
      const base = finalizeOpenThinking(flatItems, at);
      return normalizeToolStructure(upsertPlanToolCall(base, turnId, event), turnId);
    }

    // session-config / meta variants never reach foldItem (router intercepts them),
    // but the extended NormalizedEvent union requires a total switch.
    case 'agent_state':
    case 'ignored':
    // falls through
    default:
      return items;
  }
}

/**
 * Settle in-progress states owned by a committed turn.
 *
 * - thinking status 'thinking' → 'done' + computed durationMs
 * - tool status 'running' → 'done', without crossing a subagent boundary
 *
 * Input must be plain objects (not Solid/MobX proxies).
 */
export function finalizeItems(items: TranscriptItem[], at: number): TranscriptItem[] {
  const finalizeNode = (item: ToolNode): ToolNode => {
    if (isToolGroup(item)) {
      const children = item.children.map(finalizeNode);
      return { ...item, children, status: readGroupStatus(children) };
    }

    // The launch belongs to this turn; its nested tools belong to the child.
    // Their own tool updates can still arrive after this turn is committed.
    const children = item.kind === 'spawn-subagent-tool-call'
      ? item.children
      : item.children?.map(finalizeNode);
    const status = item.status === 'running' ? 'done' : item.status;
    return {
      ...item,
      status,
      ...(children?.length ? { children } : {}),
    } as ToolNode;
  };

  return items.map((item): TranscriptItem => {
    switch (item.kind) {
      case 'message':
        return item;
      case 'thinking':
        return item.status === 'thinking'
          ? { ...item, status: 'done' as const, durationMs: at - item.startedAt }
          : item;
      // 压缩行没有「跑着/跑完」这一层要收口的东西 —— 它的状态由 agent 的续报决定,
      // ❌ 不许在收尾时替它把 `in_progress` 改成 completed:那会把一次**失败**的压缩
      // 谎报成成功,而失败恰恰是用户最需要知道的那种(上下文没压掉,下一轮可能撞窗口)。
      case 'compaction':
        return item;
      // 同理:界线行没有要收口的状态。
      case 'context-reset':
        return item;
      // 会话通知行同理 —— 它说的是这条会话的运行条件,与哪一轮跑成跑砸无关。
      case 'session-notice':
        return item;
      case 'execute-tool-call':
      case 'read-tool-call':
      case 'create-file-tool-call':
      case 'modify-file-tool-call':
      case 'delete-file-tool-call':
      case 'search-tool-call':
      case 'mcp-tool-call':
      case 'web-fetch-tool-call':
      case 'spawn-subagent-tool-call':
      case 'subagent-done-tool-call':
      case 'background-command-done-tool-call':
      case 'create-plan-tool-call':
      case 'unknown-tool-call':
      case 'tool-group':
        return finalizeNode(item) as TranscriptItem;
    }
  });
}

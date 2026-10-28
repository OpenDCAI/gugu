import { z } from 'zod';
import type { TerminalExit } from '../terminals';
import { terminalExitSchema } from '../terminals';
import type { ToolCallGroupKind, ToolStatus } from './tools';
import { toolCallGroupKindSchema, toolStatusSchema } from './tools';

/**
 * 一张工具交回来的图:ACP `content` 里 `{ type: 'image', data, mimeType }` 那一块,原样留下(148 10-14)。
 * MCP 工具的结果块就是 ACP 的块 —— App 的 app_check、浏览器截图……两个桥都这么交(Codex 桥自 10-14 起)。
 * 文字块照旧落 `outputText`;图以前被解码丢掉,卡上只剩一句 `[Image: …]`。
 */
export const toolImageSchema = z.object({
  mimeType: z.string(),
  /** base64,不带 `data:` 前缀。 */
  data: z.string(),
});
export type ToolImage = z.infer<typeof toolImageSchema>;

/** One lazy tool picture, or the existing record lookup's precise refusal. */
export const toolImageLookupSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), image: toolImageSchema }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['no_such_item', 'no_such_image', 'too_large']),
    message: z.string(),
  }),
]);
export type ToolImageLookup = z.infer<typeof toolImageLookupSchema>;

/** 画这张图用的地址(桌面工具卡与手机工具卡同一个)。 */
export function toolImageUrl(image: ToolImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/**
 * 历史传输投影里的一张图:只说有这么一张、多大(base64 字数),图本身不带(transport-trim)。界面滚到它时
 * 按 (会话, 条目, 第几张) 去机器上取(`sessionTimeline.sessionToolImage`)。
 */
export const toolImageRefSchema = z.object({
  mimeType: z.string(),
  chars: z.number().int().nonnegative(),
});
export type ToolImageRef = z.infer<typeof toolImageRefSchema>;

export interface BaseToolCallItem {
  id: string;
  seq: number;
  toolCallId: string;
  title: string;
  /**
   * 供应商报的工具名,标题是给人看的显示名时靠它认工具(Claude ACP 适配器每条调用都在 `_meta.claudeCode.toolName`
   * 报,EnrichHook 提上来;计划批准的标题是「Approve Plan」、工具名是 ExitPlanMode)。认「这是哪个工具」一律经 `toolCallName`。
   */
  toolName?: string;
  status: ToolStatus;
  /** Authentic arrival/completion clocks; absent in provider replay. */
  at?: number;
  completedAt?: number;
  inputSummary?: string;
  rawInput?: string;
  rawOutput?: string;
  outputText?: string;
  /** 工具交回来的图(ACP `content` 里的 image 块),见 `ToolImage`。 */
  images?: ToolImage[];
  /** 历史传输投影里替代 `images` 的那一格:每张图的类型和大小,图要另取。见 `ToolImageRef`。 */
  imageRefs?: ToolImageRef[];
  /**
   * 这次调用**留下了一个还在跑的后台任务**(claude 的 `run_in_background` Bash、
   * workflow),供应商给的任务 id(#5117)。停它时报给供应商的是这次调用的 `toolCallId`。
   *
   * ⚠️ 与调用自己的 `status` 不是一回事:派发调用在派出去那一刻就完成了,后台那件事
   * 还在跑 —— 只看 status 判不出「有没有东西还在跑」。
   */
  backgroundTaskId?: string;
  /** 那个后台任务的完成通知到了 —— 它不再在跑(#5117)。 */
  backgroundTaskDone?: true;
  parentToolCallId?: string;
  children?: ToolNode[];
  /**
   * Shared phone/desktop history preview: characters omitted by transport-trim.
   * The source record stays complete; this metadata lets the tool card disclose the cropped preview.
   */
  trimmedChars?: number;
}

export interface ExecuteToolCall extends BaseToolCallItem {
  kind: 'execute-tool-call';
  command?: string;
  terminalId?: string;
  /** How the command's process ended, when the provider reported it. */
  exitStatus?: TerminalExit;
}

export interface ReadToolCall extends BaseToolCallItem {
  kind: 'read-tool-call';
  path?: string;
  resource?: string;
}

export interface FileToolCallBase extends BaseToolCallItem {
  path: string;
}

export interface CreateFileToolCall extends FileToolCallBase {
  kind: 'create-file-tool-call';
  content: string;
}

export interface ModifyFileToolCall extends FileToolCallBase {
  kind: 'modify-file-tool-call';
  oldText: string;
  newText: string;
}

export interface DeleteFileToolCall extends FileToolCallBase {
  kind: 'delete-file-tool-call';
}

export interface SearchToolCall extends BaseToolCallItem {
  kind: 'search-tool-call';
  query: string;
  matchCount?: number;
}

export interface McpToolCall extends BaseToolCallItem {
  kind: 'mcp-tool-call';
  server?: string;
  tool: string;
}

export interface WebFetchToolCall extends BaseToolCallItem {
  kind: 'web-fetch-tool-call';
  url: string;
  pageTitle?: string;
}

export interface SpawnSubagentToolCall extends BaseToolCallItem {
  subagentSessionId?: string;
  agentStatus?: 'running' | 'completed' | 'failed' | 'lost' | 'stopped';
  agentStartedAt?: number;
  canCancel?: boolean;
  reasoningText?: string;
  kind: 'spawn-subagent-tool-call';
  name: string;
  background?: boolean;
  agentId?: string;
  /**
   * 这个子 agent 实际跑在哪个模型上(#4981)。
   *
   * 上游 `elements-subagent-list` 的每张卡都带模型名(它的 `args.model`);ACP 这边的
   * 对应物是 claude 在 `_meta.claudeCode.toolResponse.resolvedModel` 里给的那个值 ——
   * 录制里实测是 `claude-opus-4-8[1m]`。⚠️ 拿不到就**不画**,❌ 不拿会话模型冒充:
   * 派出去的子 agent 可以跑在与主会话不同的模型上,这正是要显示它的理由。
   */
  model?: string;
  /**
   * 它被派出去的那一刻(墙钟)。进度条的第二个量尺 —— 见 `subagent-progress`。
   *
   * ⚠️ 存的是**事件到达时刻**,不是组件挂载时刻:虚拟列表把行滚出视窗就卸载,
   * 拿挂载时刻当起点的话,重挂一次条子就往回跳。存进条目里,滚多少个来回都是同一个数。
   * ⚠️ 只在**第一次**建这条条目时写,之后的更新事件不覆盖(与 title 那条同一个约定)。
   */
  startedAt?: number;
}

/**
 * 「那个子智能体跑完了」这一行(#4981)。
 *
 * owner 2026-09-06:「子智能体运行完你就当 toolcall 渲染就行了,agent complete 类似于」
 * ⇒ 派发是一行、跑完是**另一行**,两行都是工具调用,走同一套渲染。
 *
 * ⚠️ 它的 `toolCallId` 是**通知自己的** id(`task-notification:<派发调用 id>`),
 * ❌ 不能复用派发那次调用的 id —— 复用的话 fold 会把它认成同一次调用的更新,
 * 结果就是「跑完了」这件事又变回了对派发行的一次状态改写,而那正是 owner 否掉的模型。
 * 派它出去的那次调用记在 `launchToolCallId`,面板据此知道哪张卡该撤。
 */
export interface SubagentDoneToolCall extends BaseToolCallItem {
  kind: 'subagent-done-tool-call';
  /** 是谁跑完了。查登记册查出来的;查不到是空串,行上落到通用词,❌ 不编。 */
  name: string;
  /** 运行时给这个子智能体的 id。 */
  agentId: string;
  /** 派它出去的那次调用。 */
  launchToolCallId: string;
  /**
   * 那个子智能体是跑成了还是跑砸了。
   *
   * ⚠️ **不放在 `status` 里**:`status` 说的是这一行代表的**调用**(通知送达)完没完成 ——
   * 通知到了就是 done。子智能体失败是它带回来的**内容**,行名写「子智能体失败」就够了;
   * 若把它塞进 status='error',通用工具行会再打一个 ❌(owner 2026-09-06:「子智能体失败
   * 也是不要有❌号,我觉得这些都是 tool call」)。
   */
  outcome: 'completed' | 'failed' | 'stopped';
  /** 供应商给的一句话总结,可能没有。 */
  summary?: string;
  /** 它的输出落在哪个文件里,可能没有。 */
  outputFile?: string;
}

/**
 * 「后台命令跑完了」那一行(#5117)—— `SubagentDoneToolCall` 的镜像:派发一行(命令卡)、
 * 跑完另一行,两行都是工具调用。owner 2026-09-07:「命令完成没有提示啊,agent 运行完都有提示」。
 * 同样 ❌ 不复用命令卡的 id;派它那次调用记在 `launchToolCallId`。
 */
export interface BackgroundCommandDoneToolCall extends BaseToolCallItem {
  kind: 'background-command-done-tool-call';
  /** 那条命令(命令卡的标题);一个字都没有就空串,行上落到通用词,❌ 不编。 */
  name: string;
  /** 起它那次调用(命令卡)。 */
  launchToolCallId: string;
  /** 跑成 / 跑砸 / 被叫停 —— 与 SubagentDoneToolCall 同一约定,❌ 不放进 status。 */
  outcome: 'completed' | 'failed' | 'stopped';
  summary?: string;
}

export interface CreatePlanToolCall extends BaseToolCallItem {
  kind: 'create-plan-tool-call';
  planId: string;
}

export interface UnknownToolCall extends BaseToolCallItem {
  kind: 'unknown-tool-call';
  toolKind: string | null;
  name: string;
}

export interface ToolGroup {
  kind: 'tool-group';
  id: string;
  seq: number;
  label: string;
  groupKind: ToolCallGroupKind;
  status: ToolStatus;
  children: ToolNode[];
}

export type ToolCallItem =
  | ExecuteToolCall
  | ReadToolCall
  | CreateFileToolCall
  | ModifyFileToolCall
  | DeleteFileToolCall
  | SearchToolCall
  | McpToolCall
  | WebFetchToolCall
  | SpawnSubagentToolCall
  | SubagentDoneToolCall
  | BackgroundCommandDoneToolCall
  | CreatePlanToolCall
  | UnknownToolCall;

export type ToolNode = ToolCallItem | ToolGroup;

/**
 * What a tool call is called — the one answer for the desktop tool row, recent actions, the pending card and the phone.
 *   · a group: the label the reducer gave it;
 *   · MCP: the tool. 咕咕's `catalog_call` runs another tool "exactly as if it were in your tool list"
 *     (electron/mcp/gugu-catalog-tools.ts, input `{ tool, args }`): the call is that tool — an App's is `<app id>__<tool>`.
 *     Read from the input when shown: Claude's first `tool_call` carries `rawInput: {}`, the input comes with a later update;
 *   · otherwise the provider's title; an unknown kind falls back to its name, then to its toolKind (read / execute / fetch …).
 * item-fold writes `title: event.title ?? 'unknown'` (and `name: title`) when an event has none — a placeholder, not a name.
 * Nothing left = '' and the renderer says it in the user's language.
 */
export function toolDisplayName(node: ToolNode): string {
  if (node.kind === 'tool-group') return node.label;
  if (node.kind === 'mcp-tool-call') return catalogCall(node.tool, node.rawInput)?.tool ?? named(node.tool) ?? '';
  return named(node.title) ?? (node.kind === 'unknown-tool-call' ? (named(node.name) ?? node.toolKind ?? '') : '');
}

/**
 * How an approval names the call: an MCP tool with its server, `playwright · browser_navigate` (the Claude Code client's
 * way — a bare tool name does not say which of the user's servers asks), the name alone when there is no server;
 * any other call by its name. The provider's raw title only when nothing else is left.
 */
export function toolCallLabel(toolCall: ToolCallItem): string {
  const name = toolDisplayName(toolCall);
  const label = toolCall.kind === 'mcp-tool-call' ? [toolCall.server, name].filter(Boolean).join(' · ') : name;
  return label || toolCall.title;
}

function named(value: string | null | undefined): string | null {
  return value && value !== 'unknown' ? value : null;
}

/** The call a `catalog_call` runs: its tool and that tool's own args (the name above, the phone's preview); null until the input says. */
export function catalogCall(tool: string, rawInput: string | undefined): { tool: string; args: unknown } | null {
  if (tool !== 'catalog_call' || !rawInput) return null;
  try {
    const input = JSON.parse(rawInput) as { tool?: unknown; args?: unknown } | null;
    return typeof input?.tool === 'string' && input.tool !== '' ? { tool: input.tool, args: input.args } : null;
  } catch {
    return null;
  }
}

const toolChildrenSchema: z.ZodType<ToolNode[]> = z.lazy(() => z.array(toolNodeSchema));

export const baseToolCallItemSchema = z.object({
  id: z.string(),
  /** Stable order within the owning sibling list, assigned once by the reducer. */
  seq: z.number().int(),
  /** Provider tool call id, stable across tool_call and tool_call_update notifications. */
  toolCallId: z.string(),
  title: z.string(),
  status: toolStatusSchema,
  at: z.number().optional(),
  completedAt: z.number().optional(),
  /** Provider/plugin-generated short input description for compact display. */
  inputSummary: z.string().optional(),
  /**
   * The arguments the agent handed the tool, as ACP reports them in `rawInput`,
   * serialized for display. Kept for every kind, not just the ones with a
   * dedicated renderer: without it a tool call's inputs are unreachable in the
   * UI, which is the gap #3334 row 24 names.
   */
  rawInput: z.string().optional(),
  /** The tool's own return value, as ACP reports it in `rawOutput`, serialized. */
  rawOutput: z.string().optional(),
  /**
   * Text output reported by ACP `tool_call_update` content blocks. Preferred
   * over `rawOutput` when both are present: content is the channel the provider
   * meant to be read, rawOutput is whatever the vendor happened to return.
   */
  outputText: z.string().optional(),
  /** 工具交回来的图;见 `toolImageSchema`。 */
  images: z.array(toolImageSchema).optional(),
  /** 发给手机那一份里的图(只有类型和大小);见 `toolImageRefSchema`。 */
  imageRefs: z.array(toolImageRefSchema).optional(),
  /** 供应商自己的工具名(标题是显示名时);见 BaseToolCallItem。 */
  toolName: z.string().optional(),
  /** 这次调用留下的后台任务 id;它还在跑,直到 `backgroundTaskDone`(#5117)。 */
  backgroundTaskId: z.string().optional(),
  /** 那个后台任务的完成通知到了(#5117)。 */
  backgroundTaskDone: z.literal(true).optional(),
  /** 发给手机时被裁掉的字数(传输层痕迹,桌面侧恒缺;见 session-record/transport-trim.ts)。 */
  trimmedChars: z.number().int().positive().optional(),
  /** Raw provider parent id used to rebuild the tree; not a render link. */
  parentToolCallId: z.string().optional(),
  /** Nested provider or reducer-derived tool nodes owned by this call. */
  children: toolChildrenSchema.optional(),
});

export const executeToolCallSchema = baseToolCallItemSchema.extend({
  kind: z.literal('execute-tool-call'),
  command: z.string().optional(),
  /** Managed terminal id when this execute call is backed by terminal state. */
  terminalId: z.string().optional(),
  /** How the command's process ended, when the provider reported it. */
  exitStatus: terminalExitSchema.optional(),
});

export const readToolCallSchema = baseToolCallItemSchema.extend({
  kind: z.literal('read-tool-call'),
  path: z.string().optional(),
  resource: z.string().optional(),
});

export const fileToolCallBaseSchema = baseToolCallItemSchema.extend({
  path: z.string(),
});

export const createFileToolCallSchema = fileToolCallBaseSchema.extend({
  kind: z.literal('create-file-tool-call'),
  content: z.string(),
});

export const modifyFileToolCallSchema = fileToolCallBaseSchema.extend({
  kind: z.literal('modify-file-tool-call'),
  oldText: z.string(),
  newText: z.string(),
});

export const deleteFileToolCallSchema = fileToolCallBaseSchema.extend({
  kind: z.literal('delete-file-tool-call'),
});

export const searchToolCallSchema = baseToolCallItemSchema.extend({
  kind: z.literal('search-tool-call'),
  query: z.string(),
  /** Provider-reported approximate match count when available. */
  matchCount: z.number().int().optional(),
});

export const mcpToolCallSchema = baseToolCallItemSchema.extend({
  kind: z.literal('mcp-tool-call'),
  /** MCP server name/id when the provider exposes it separately from the tool name. */
  server: z.string().optional(),
  tool: z.string(),
});

export const webFetchToolCallSchema = baseToolCallItemSchema.extend({
  kind: z.literal('web-fetch-tool-call'),
  url: z.string(),
  pageTitle: z.string().optional(),
});

export const spawnSubagentToolCallSchema = baseToolCallItemSchema.extend({
  model: z.string().optional(),
  subagentSessionId: z.string().optional(),
  agentStatus: z.enum(['running', 'completed', 'failed', 'lost', 'stopped']).optional(),
  agentStartedAt: z.number().optional(),
  canCancel: z.boolean().optional(),
  reasoningText: z.string().optional(),
  kind: z.literal('spawn-subagent-tool-call'),
  name: z.string(),
  /** True for async/background agents that can outlive the turn that launched them. */
  background: z.boolean().optional(),
  /** Provider/runtime id for matching later background-agent status updates. */
  agentId: z.string().optional(),
});

export const subagentDoneToolCallSchema = baseToolCallItemSchema.extend({
  kind: z.literal('subagent-done-tool-call'),
  name: z.string(),
  agentId: z.string(),
  /** 派它出去的那次调用 —— 与本行自己的 toolCallId 不是一个值。 */
  launchToolCallId: z.string(),
  outcome: z.enum(['completed', 'failed', 'stopped']),
  summary: z.string().optional(),
  outputFile: z.string().optional(),
});

export const backgroundCommandDoneToolCallSchema = baseToolCallItemSchema.extend({
  kind: z.literal('background-command-done-tool-call'),
  name: z.string(),
  launchToolCallId: z.string(),
  outcome: z.enum(['completed', 'failed', 'stopped']),
  summary: z.string().optional(),
});

export const createPlanToolCallSchema = baseToolCallItemSchema.extend({
  kind: z.literal('create-plan-tool-call'),
  /** Session-scoped plan id resolved against PlanState. */
  planId: z.string(),
});

export const unknownToolCallSchema = baseToolCallItemSchema.extend({
  kind: z.literal('unknown-tool-call'),
  toolKind: z.string().nullable(),
  name: z.string(),
});

export const toolCallItemSchema = z.discriminatedUnion('kind', [
  executeToolCallSchema,
  readToolCallSchema,
  createFileToolCallSchema,
  modifyFileToolCallSchema,
  deleteFileToolCallSchema,
  searchToolCallSchema,
  mcpToolCallSchema,
  webFetchToolCallSchema,
  spawnSubagentToolCallSchema,
  subagentDoneToolCallSchema,
  backgroundCommandDoneToolCallSchema,
  createPlanToolCallSchema,
  unknownToolCallSchema,
]);

export const toolGroupSchema = z.object({
  kind: z.literal('tool-group'),
  id: z.string(),
  /** Stable order within the owning sibling list, derived from the first child. */
  seq: z.number().int(),
  label: z.string(),
  groupKind: toolCallGroupKindSchema,
  status: toolStatusSchema,
  children: toolChildrenSchema,
});

export const toolNodeSchema: z.ZodType<ToolNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    executeToolCallSchema,
    readToolCallSchema,
    createFileToolCallSchema,
    modifyFileToolCallSchema,
    deleteFileToolCallSchema,
    searchToolCallSchema,
    mcpToolCallSchema,
    webFetchToolCallSchema,
    spawnSubagentToolCallSchema,
    subagentDoneToolCallSchema,
    backgroundCommandDoneToolCallSchema,
    createPlanToolCallSchema,
    unknownToolCallSchema,
    toolGroupSchema,
  ])
);

/**
 * 这次调用是哪个工具:有供应商的工具名用它,没有再看标题(会话记录里标题就是工具名)。
 * 认工具的地方(提问切开折叠、权限请求在等什么)只经这一处取名,❌ 各写一套回退。
 */
export function toolCallName(item: { title: string; toolName?: string }): string {
  return item.toolName ?? item.title;
}

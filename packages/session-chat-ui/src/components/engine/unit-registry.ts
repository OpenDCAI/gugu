/**
 * unit-registry — segmenter and unit-def registries for the flat unit engine.
 *
 * Two independent maps:
 *
 *   SEGMENTERS   — ChatItem.kind → ItemSegmenter
 *                  Defines how each transcript item is split into RenderUnits.
 *
 *   UNIT_REGISTRY — unit.kind → UnitDef
 *                   Defines how each unit kind is measured and rendered.
 *
 * Adding a new ChatItem kind:
 *   1. Implement a UnitDef<D> and an ItemSegmenter in the appropriate folder.
 *   2. Register the segmenter in SEGMENTERS.
 *   3. Register the UnitDef in UNIT_REGISTRY.
 */

import { compactionUnitDef } from '@session-chat/components/rows/boundary/compaction.def';
import { contextResetUnitDef } from '@session-chat/components/rows/boundary/context-reset.def';
import { sessionConditionUnitDef } from '@session-chat/components/rows/boundary/session-condition.def';
import { backgroundTasksUnitDef } from '@session-chat/components/rows/background-tasks/background-tasks.def';
import { sessionNoticeUnitDef } from '@session-chat/components/rows/boundary/session-notice.def';
import { daySeparatorUnitDef } from '@session-chat/components/rows/day-separator/day-separator.def';
import { messageFromItem, messageUnitDef } from '@session-chat/components/rows/message/message.def';
import { fileChangeSummaryUnitDef } from '@session-chat/components/rows/file-change-summary/file-change-summary.def';
import { openedOutputUnitDef } from '@session-chat/components/rows/opened-output/opened-output.def';
import { agentSendToUnitDef } from '@session-chat/components/rows/agent-send/agent-send.def';
import { planFromItem, planUnitDef } from '@session-chat/components/rows/plan/plan.def';
import { resourceLinkUnitDef } from '@session-chat/components/rows/resource-link/resource-link.def';
import { thinkingUnitDef } from '@session-chat/components/rows/thinking/thinking.def';
import {
  patchDiffFromItem,
  diffUnitDef,
} from '@session-chat/components/rows/tools/diff/diff.def';
import { executeFromItem, executeUnitDef } from '@session-chat/components/rows/tools/execute/execute.def';
import { planReviewFromItem, planReviewUnitDef } from '@session-chat/components/rows/tools/plan-review/plan-review.def';
import {
  fileOpUnitDef,
  readFileOpFromItem,
} from '@session-chat/components/rows/tools/file-op/file-op.def';
import { subagentFromItem, subagentUnitDef } from '@session-chat/components/rows/tools/subagent/subagent.def';
import { toolGroupUnitDef } from '@session-chat/components/rows/tools/tool-group/tool-group.def';
import { toolFromItem, toolUnitDef } from '@session-chat/components/rows/tools/tool/tool.def';
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def';
import { turnProcessUnitDef } from '@session-chat/components/rows/turn-process/turn-process.def';
import { turnCompletionUnitDef } from '@session-chat/components/rows/turn-process/turn-completion.def';
import { toolRunUnitDef } from '@session-chat/components/rows/tool-run/tool-run.def';
import { conversationStepUnitDef } from '@session-chat/components/rows/conversation-step/conversation-step.def';
import { toolCallName } from '@gugu/session-core/acp/client';
import { isPlanApprovalToolName, isQuestionOrPlanToolName } from '@gugu/session-core/session-record/question-tools';
import type { GroupChrome, ItemSegmenter, SegmentCtx, SegmentItem, UnitDef } from '@session-chat/core/units';
import { unit } from '@session-chat/core/units';
import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';
import type { ItemNode } from '@session-chat/state/flatten';
import type {
  AgentSendItem,
  ChatDiff,
  ChatExecute,
  ChatFileOpToolCall,
  ChatItem,
  ChatMessage,
  ChatPlan,
  ChatSubagentToolCall,
  ChatToolCall,
  SyntheticItem,
  ToolNode,
} from '@session-chat/model';
import { ROW_INSET_X } from './row-metrics';

// ── Native single-unit segmenter for composites ───────────────────────────────
//
// Each composite item becomes exactly one RenderUnit with chrome.insetX so
// the native UnitDef.measure receives the same effective width as Row.tsx used.

type ToolPresentationData =
  | ChatExecute
  | ChatFileOpToolCall
  | ChatDiff
  | ChatPlan
  | ChatSubagentToolCall
  | ChatToolCall;
type RegistryUnitDef = UnitDef<unknown, Record<string, number>>;

function nativePassthrough<T extends SegmentItem>(
  kind: string,
  toData: (item: T, ctx: SegmentCtx) => unknown,
  chrome?: GroupChrome
): ItemSegmenter {
  return {
    kind,
    chrome,
    segment: (item, ctx) => [unit(kind, item, toData(item as T, ctx), { key: 'self' })],
  };
}

/** Chrome shared by all non-user-message composite rows (matches legacy Row.tsx inset). */
const COMPOSITE_CHROME: GroupChrome = { insetX: ROW_INSET_X };

/**
 * Conversation messages align with the composer edge. UserMessageCard owns
 * its own bubble padding; assistant text needs no extra horizontal inset.
 */
const MESSAGE_CHROME: GroupChrome = { insetX: 0 };

/**
 * Role-aware message segmenter.
 *
 * Each message becomes exactly one unit with key='self'. The chrome is set
 * per-unit (not on the segmenter) so flatten.ts does not overwrite it with a
 * single shared value. Conversation messages share the composer edge; hook
 * notices retain their inset as process cards.
 *
 * A declined turn is the one message that becomes *no* unit (#4552). Returning
 * an empty group is how a segmenter says "there is nothing to draw here" —
 * flatten drops the group whole. It is the only correct way to do it: a row that
 * renders empty is a zero-height virtualizer element, and agent-reply spec has
 * the receipts for what that costs (a console error per measurement pass, #2186).
 */
const messageSegmenter: ItemSegmenter = {
  kind: 'message',
  // No top-level chrome: we set u.chrome per-unit in segment() below so
  // flatten's chrome-copy pass (which only fires when seg.chrome is truthy)
  // cannot overwrite the per-role value we assigned.
  segment: (item, ctx) => {
    const data = messageFromItem(item as ChatMessage, ctx);
    // Only the agent's own voice can decline a turn; the marker inside a user
    // message is text a person typed, and quoting it is not declining anything.
    if (data.role === 'assistant' && isGuguSilence(data.text, { streaming: data.streaming })) return [];
    // 对话布局里回复的头那一行(名字 + 过程行)不带正文,正文在下面的气泡行里。
    if (!ctx.active && data.role === 'assistant' && !data.text.trim() && !data.attachments?.length && data.conversationPart !== 'head') return [];
    const u = unit('message', item, data, { key: 'self' });
    u.chrome = data.hookNotice ? COMPOSITE_CHROME : MESSAGE_CHROME;
    return [u];
  },
};

/**
 * agent 经 message_send / session_message 说的话(`AgentSendItem`,flatten 在那次调用的位置上造出来):
 * 话本身是一条 agent 消息,交给 message 那一套画、量(markdown、复制、高度都同一份);下面一行说发到了哪里。
 */
const agentSendSegmenter: ItemSegmenter = {
  kind: 'agent-send',
  segment: (item, ctx) => {
    const send = item as AgentSendItem;
    const said = { kind: 'message', id: send.id, seq: 0, role: 'assistant', text: send.send.text } as ChatMessage;
    const body = messageSegmenter.segment(said, ctx);
    if (body.length === 0) return [];
    const to = unit('agent-send-to', send, send, { key: 'to' });
    to.chrome = MESSAGE_CHROME;
    return [...body, to];
  },
};

function toToolGroupNode(item: ToolNode, ctx: SegmentCtx): ItemNode {
  const header = item.kind === 'tool-group' ? toolFromItem(item, ctx) : toUnitData(item, ctx);
  const children =
    item.kind === 'tool-group'
      ? item.children.map((child: ToolNode) => toToolGroupNode(child, ctx))
      : 'children' in item && item.children
        ? item.children.map((child: ToolNode) => toToolGroupNode(child, ctx))
        : [];
  return { item: header, children };
}

function toUnitData(item: ToolNode, ctx: SegmentCtx): ToolPresentationData {
  switch (item.kind) {
    case 'execute-tool-call':
      return executeFromItem(item, ctx);
    case 'read-tool-call':
      return readFileOpFromItem(item, ctx);
    case 'patch-tool-call':
      return patchDiffFromItem(item, ctx);
    case 'create-plan-tool-call':
      return planFromItem(item, ctx);
    case 'spawn-subagent-tool-call':
      return subagentFromItem(item, ctx);
    case 'tool-group':
      return toolFromItem(item, ctx);
    default:
      return toolFromItem(item, ctx);
  }
}

function toolNodeSegment(kind: ToolNode['kind']): ItemSegmenter {
  return {
    kind,
    chrome: COMPOSITE_CHROME,
    segment(item, ctx) {
      const tool = item as ToolNode;
      if (ctx.agentConversation && tool.kind !== 'tool-group' && !isQuestionOrPlanToolName(toolCallName(tool))) {
        const row = unit('conversation-step', tool, tool, { key: 'self' });
        row.chrome = MESSAGE_CHROME;
        return [row];
      }
      // 派发子智能体那一行**永远是一行**:它下面挂着的是那个子智能体自己跑的调用,
      // 而那些 ❌ 不进主消息列表(owner 2026-09-05),所以这里不许走成可展开的组。
      // 那批调用没有丢 —— 花名册按 `parentToolCallId` 收走了,显示在面板上它那张卡上。
      if (tool.kind === 'spawn-subagent-tool-call') {
        const data = toUnitData(tool, ctx);
        return [unit(data.kind, tool, data, { key: 'self' })];
      }
      // 计划审批是一张卡，不是一行工具（#7139）。
      if ('toolCallId' in tool && isPlanApprovalToolName(toolCallName(tool))) {
        return [unit('plan-review', tool, planReviewFromItem(tool, ctx), { key: 'self' })];
      }
      const children = tool.kind === 'tool-group' ? tool.children : tool.children;
      if (children && children.length > 0) {
        return [unit('tool-group', tool, toToolGroupNode(tool, ctx), { key: 'self' })];
      }
      const data = toUnitData(tool, ctx);
      return [unit(data.kind, tool, data, { key: 'self' })];
    },
  };
}

// ── SEGMENTERS ────────────────────────────────────────────────────────────────

/**
 * Maps ChatItem.kind to its ItemSegmenter.
 *
 * Composites use nativePassthrough with COMPOSITE_CHROME so that their native
 * UnitDef.measure receives the same effective width as the old Row.tsx path
 * (rowWidth - 2 * ROW_INSET_X). The chrome.insetX is applied visually by
 * UnitRow and subtracted from rowWidth before nativeMeasureCtx.
 */
export const SEGMENTERS: Record<string, ItemSegmenter> = {
  message: messageSegmenter,
  thinking: nativePassthrough<ChatItem>('thinking', (item) => item, COMPOSITE_CHROME),
  // 上下文压缩的界线：一条 item 就是一行，没有可折叠的内部结构。
  compaction: nativePassthrough<ChatItem>('compaction', (item) => item, COMPOSITE_CHROME),
  // 引擎重开会话的界线：同样是一条 item 一行。
  'context-reset': nativePassthrough<ChatItem>('context-reset', (item) => item, COMPOSITE_CHROME),
  'session-notice': nativePassthrough<ChatItem>('session-notice', (item) => item, COMPOSITE_CHROME),
  'session-condition': nativePassthrough<ChatItem>('session-condition', (item) => item, COMPOSITE_CHROME),
  'background-tasks': nativePassthrough<ChatItem>('background-tasks', (item) => item, COMPOSITE_CHROME),
  tool: nativePassthrough<ChatItem>('tool', (item) => item, COMPOSITE_CHROME),
  'file-op': nativePassthrough<ChatItem>('file-op', (item) => item, COMPOSITE_CHROME),
  execute: nativePassthrough<ChatItem>('execute', (item) => item, COMPOSITE_CHROME),
  diff: nativePassthrough<ChatItem>('diff', (item) => item, COMPOSITE_CHROME),
  plan: nativePassthrough<ChatItem>('plan', (item) => item, COMPOSITE_CHROME),
  subagent: nativePassthrough<ChatItem>('subagent', (item) => item, COMPOSITE_CHROME),
  'resource-link': nativePassthrough<ChatItem>('resource-link', (item) => item, COMPOSITE_CHROME),
  'execute-tool-call': toolNodeSegment('execute-tool-call'),
  'read-tool-call': toolNodeSegment('read-tool-call'),
  'patch-tool-call': toolNodeSegment('patch-tool-call'),
  'search-tool-call': toolNodeSegment('search-tool-call'),
  'mcp-tool-call': toolNodeSegment('mcp-tool-call'),
  'web-fetch-tool-call': toolNodeSegment('web-fetch-tool-call'),
  'spawn-subagent-tool-call': toolNodeSegment('spawn-subagent-tool-call'),
  // 「跑完了」那一行走通用工具渲染 —— owner 2026-09-06:「当 toolcall 渲染就行了」。
  'subagent-done-tool-call': toolNodeSegment('subagent-done-tool-call'),
  // 后台命令跑完那一行,同一形态(#5117)。
  'background-command-done-tool-call': toolNodeSegment('background-command-done-tool-call'),
  'create-plan-tool-call': toolNodeSegment('create-plan-tool-call'),
  'unknown-tool-call': toolNodeSegment('unknown-tool-call'),
  'tool-group': toolNodeSegment('tool-group'),
  'turn-outcome': nativePassthrough<SyntheticItem>(
    'turn-outcome',
    (item) => item,
    COMPOSITE_CHROME
  ),
  'day-separator': nativePassthrough<SyntheticItem>(
    'day-separator',
    (item) => item,
    COMPOSITE_CHROME
  ),
  'turn-process': nativePassthrough<SyntheticItem>('turn-process', (item) => item, MESSAGE_CHROME),
  'turn-completion': nativePassthrough<SyntheticItem>('turn-completion', (item) => item, MESSAGE_CHROME),
  'tool-run': nativePassthrough<SyntheticItem>('tool-run', (item) => item, COMPOSITE_CHROME),
  'file-change-summary': nativePassthrough<SyntheticItem>('file-change-summary', (item) => item, MESSAGE_CHROME),
  'opened-output': nativePassthrough<SyntheticItem>('opened-output', (item) => item, COMPOSITE_CHROME),
  'agent-send': agentSendSegmenter,
};

// ── UNIT_REGISTRY ─────────────────────────────────────────────────────────────

/**
 * Maps unit.kind to its UnitDef.
 *
 * message: single-unit def; measure/Render handle block layout internally.
 * Composite item unit defs also handle their own internal layout.
 */
export const UNIT_REGISTRY: Record<string, RegistryUnitDef> = {
  // Message unit (single unit per message, renders block stack internally)
  message: messageUnitDef as unknown as RegistryUnitDef,
  // Composite item units (single-unit per ChatItem kind)
  diff: diffUnitDef as unknown as RegistryUnitDef,
  plan: planUnitDef as unknown as RegistryUnitDef,
  thinking: thinkingUnitDef as unknown as RegistryUnitDef,
  compaction: compactionUnitDef as unknown as RegistryUnitDef,
  'context-reset': contextResetUnitDef as unknown as RegistryUnitDef,
  'session-notice': sessionNoticeUnitDef as unknown as RegistryUnitDef,
  'session-condition': sessionConditionUnitDef as unknown as RegistryUnitDef,
  'background-tasks': backgroundTasksUnitDef as unknown as RegistryUnitDef,
  'file-op': fileOpUnitDef as unknown as RegistryUnitDef,
  subagent: subagentUnitDef as unknown as RegistryUnitDef,
  tool: toolUnitDef as unknown as RegistryUnitDef,
  execute: executeUnitDef as unknown as RegistryUnitDef,
  'resource-link': resourceLinkUnitDef as unknown as RegistryUnitDef,
  // Hierarchical composite: parent tool call with nested children
  'tool-group': toolGroupUnitDef as unknown as RegistryUnitDef,
  'turn-outcome': turnOutcomeUnitDef as unknown as RegistryUnitDef,
  'day-separator': daySeparatorUnitDef as unknown as RegistryUnitDef,
  'turn-process': turnProcessUnitDef as unknown as RegistryUnitDef,
  'turn-completion': turnCompletionUnitDef as unknown as RegistryUnitDef,
  'tool-run': toolRunUnitDef as unknown as RegistryUnitDef,
  'conversation-step': conversationStepUnitDef as unknown as RegistryUnitDef,
  'plan-review': planReviewUnitDef as unknown as RegistryUnitDef,
  'file-change-summary': fileChangeSummaryUnitDef as unknown as RegistryUnitDef,
  'opened-output': openedOutputUnitDef as unknown as RegistryUnitDef,
  'agent-send-to': agentSendToUnitDef as unknown as RegistryUnitDef,
};

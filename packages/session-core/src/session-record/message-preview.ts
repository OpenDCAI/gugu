import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';
import type { ToolNode, TranscriptItem, TranscriptTurn, TranscriptTurnOutcome } from '../acp/client';

/**
 * MessagePreview(#6357):working 栏悬浮卡的线上契约 + 宿主侧投影。纯函数、无 node 依赖。
 * 宿主把 agent 最近几个回合原样按时间顺序投影成卡片内容,推到 `gugu:preview:{chat}:{agent}`;
 * 不按替哪个 chat 做来切段或过滤(#6573)。
 */

export const MESSAGE_PREVIEW_RPC = {
  subscribe: 'taskpage.preview.subscribe',
  keepalive: 'taskpage.preview.keepalive',
  unsubscribe: 'taskpage.preview.unsubscribe',
} as const;

export const MESSAGE_PREVIEW_EVENT = 'preview';

/** 与 gugu-supabase `chat.message_preview_relay` 拼的 topic 逐字相同。 */
export function messagePreviewTopic(chatId: string, agentId: string): string {
  return `gugu:preview:${chatId}:${agentId}`;
}

/** working 栏的状态键(`agentRunningVerb.ts`)+ `messaging`(咕咕发消息工具)。 */
export type MessagePreviewStateKey =
  | 'reading'
  | 'searching'
  | 'editing'
  | 'executing'
  | 'thinking'
  | 'running'
  | 'messaging';

export type MessagePreviewEntry =
  /** 一条输入,只给投递信封里的消息 id;正文由 viewer 按自己的权限取。null = 没有 id(owner 在任务里直接打的字)。 */
  | { kind: 'prompt'; id: string; messageId: string | null }
  | { kind: 'text'; id: string; text: string; truncated: boolean; at: number | null }
  /** 只有类别与次数,工具名/参数/输出不出设备。 */
  | { kind: 'tool'; id: string; state: MessagePreviewStateKey; count: number };

export type MessagePreviewPayload = {
  chatId: string;
  agentId: string;
  /** 同一 epoch 内单调递增;宿主重启换 epoch。 */
  rev: number;
  epoch: string;
  running: boolean;
  /** 此刻在做什么;null = 在写正文。 */
  now: MessagePreviewStateKey | null;
  /** 最后一轮怎么收的(harness 自己报的结局:做完 / 被拒 / 出错 / 被打断);null = 还在跑或还没有回合。 */
  ended: TranscriptTurnOutcome | null;
  entries: MessagePreviewEntry[];
  at: number;
};

/** 投影本身(载荷减去 chat/agent/rev/epoch/at)。 */
export type MessagePreviewProjection = Pick<MessagePreviewPayload, 'running' | 'now' | 'ended' | 'entries'>;

export const MESSAGE_PREVIEW_MAX_ENTRIES = 6;
/** 原话只留尾部 70 字(卡片一行约 23 个汉字,约 3 行)。 */
export const MESSAGE_PREVIEW_TEXT_LIMIT = 70;

function deliveryMessageIdsOf(text: string): string[] {
  return (readDeliveryEnvelope(text)?.segments ?? []).flatMap((segment) =>
    segment.facts?.messageId ? [segment.facts.messageId] : []
  );
}

function isToolNode(item: TranscriptItem): item is ToolNode {
  return item.kind.endsWith('-tool-call') || item.kind === 'tool-group';
}

const MESSAGING_TOOL = /(?:^|[._])message_(?:send|reply|send_file)\b/;

function stateOfTool(node: ToolNode): MessagePreviewStateKey {
  if (node.kind === 'tool-group') return node.children[0] ? stateOfTool(node.children[0]) : 'running';
  if (MESSAGING_TOOL.test(node.title)) return 'messaging';
  switch (node.kind) {
    case 'read-tool-call':
      return 'reading';
    case 'search-tool-call':
    case 'web-fetch-tool-call':
      return 'searching';
    case 'patch-tool-call':
      return 'editing';
    case 'execute-tool-call':
      return 'executing';
    default:
      return 'running';
  }
}

function truncateText(text: string): { text: string; truncated: boolean } {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MESSAGE_PREVIEW_TEXT_LIMIT) return { text: flat, truncated: false };
  return { text: flat.slice(flat.length - MESSAGE_PREVIEW_TEXT_LIMIT), truncated: true };
}

/** 按时间顺序:每条输入一个 prompt(一批投递按信封各一个),agent 原话截尾,工具只留类别;thinking 不出。 */
export function projectMessagePreview(
  turns: readonly TranscriptTurn[],
): MessagePreviewProjection {
  const entries: MessagePreviewEntry[] = [];
  const push = (entry: MessagePreviewEntry) => {
    const last = entries[entries.length - 1];
    if (entry.kind === 'tool' && last?.kind === 'tool' && last.state === entry.state) {
      last.count += entry.count;
      return;
    }
    entries.push(entry);
  };

  const ordered = [...turns].sort((a, b) => a.seq - b.seq);
  let lastItem: TranscriptItem | undefined;
  for (const turn of ordered) {
    const items = [...turn.items].sort((a, b) => a.seq - b.seq);
    lastItem = items[items.length - 1];
    for (const item of items) {
      if (item.kind === 'message' && item.role === 'user') {
        const ids = deliveryMessageIdsOf(item.text);
        if (ids.length === 0) push({ kind: 'prompt', id: item.id, messageId: null });
        for (const messageId of ids) push({ kind: 'prompt', id: `${item.id}:${messageId}`, messageId });
      } else if (item.kind === 'message' && item.role === 'assistant' && item.text.trim() !== '') {
        // 一回合只说了 `[NO_REPLY]` = 它不回:卡片给群里的人看,❌ 把这一声推出去。还在写的那条按前缀判,免得标记一个字一个字地闪出来。
        if (isGuguSilence(item.text, { streaming: turn.outcome === undefined && item === lastItem })) continue;
        push({ kind: 'text', id: item.id, ...truncateText(item.text), at: item.at ?? null });
      } else if (isToolNode(item)) {
        push({ kind: 'tool', id: item.id, state: stateOfTool(item), count: 1 });
      }
    }
  }

  const last = ordered[ordered.length - 1];
  const running = last !== undefined && last.outcome === undefined;
  let now: MessagePreviewStateKey | null = null;
  if (running && lastItem?.kind === 'thinking' && lastItem.status === 'thinking') now = 'thinking';
  else if (running && lastItem && isToolNode(lastItem) && lastItem.status === 'running') now = stateOfTool(lastItem);

  // 最近那条 prompt 不能被窗口挤掉:卡片先要回答「它在为谁做什么」。
  let windowed = entries.slice(-MESSAGE_PREVIEW_MAX_ENTRIES);
  const lastPrompt = [...entries].reverse().find((entry) => entry.kind === 'prompt');
  if (lastPrompt && !windowed.includes(lastPrompt)) {
    windowed = [lastPrompt, ...entries.slice(entries.indexOf(lastPrompt) + 1).slice(-(MESSAGE_PREVIEW_MAX_ENTRIES - 1))];
  }
  return { running, now, ended: last?.outcome ?? null, entries: windowed };
}

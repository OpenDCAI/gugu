/**
 * 只给这个目录下的单测用的小件。不导出到 barrel，产品路径上没有调用者。
 */
import type { TranscriptItem, TranscriptTurn } from '../acp/models/turns';
import type { RecordEntry } from './contract';
import { AcpTranscriptParser } from '../acp/reducer';

export type ToolItemView = TranscriptItem & { status: 'running' | 'done' | 'error' };

/** 把若干轮压平成一串条目（工具组和嵌套子调用一并展开）。 */
export function collectItems(turns: readonly TranscriptTurn[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const visit = (items: readonly TranscriptItem[]): void => {
    for (const item of items) {
      out.push(item);
      const children = (item as { children?: TranscriptItem[] }).children;
      if (children?.length) visit(children);
    }
  };
  for (const turn of turns) visit(turn.items);
  return out;
}

export function textOf(items: readonly TranscriptItem[]): string {
  return items
    .filter((item) => item.kind === 'message' || item.kind === 'thinking')
    .map((item) => (item as { text: string }).text)
    .join('\n');
}

/** 一条**内容**记录（带 `event`）。边界条没有 event，靠这个类型把它挡在外面。 */
export type ContentEntry = Extract<RecordEntry, { event: object }>;

/** 只要内容条。用例断言解码结果时用它，免得每处都判一次 event 在不在。 */
export function contentEntries(entries: readonly RecordEntry[]): ContentEntry[] {
  return entries.filter((entry): entry is ContentEntry => entry.event !== undefined);
}

/** 只要边界条。 */
export function boundaryEntries(
  entries: readonly RecordEntry[]
): Array<Extract<RecordEntry, { boundary: object }>> {
  return entries.filter(
    (entry): entry is Extract<RecordEntry, { boundary: object }> => entry.boundary !== undefined
  );
}

/** Native fixture characterization: event identity, order, timestamps, boundaries and visible state. */
export function recordProjection(entries: readonly RecordEntry[]) {
  const parser = new AcpTranscriptParser({ sessionId: 'native-fixture' });
  const records = entries.map((entry) => {
    const at = entry.at ?? 1;
    if (entry.boundary) {
      const boundary = entry.boundary;
      parser.settleTurn(boundary.kind === 'turn_aborted'
        ? { kind: 'cancelled', reason: 'cancelled' }
        : boundary.kind === 'turn_failed'
          ? { kind: 'error', reason: 'prompt_failed' }
          : { kind: 'done', reason: boundary.stopReason ?? 'end_turn' }, at);
      return JSON.stringify(entry);
    }
    const event = entry.event;
    parser.pushEvent(event, at);
    return JSON.stringify({ key: entry.key, at: entry.at, event });
  });
  return {
    records,
    turns: [...parser.history, ...(parser.activeTurn ? [parser.activeTurn] : [])].map((turn) => JSON.stringify(turn)),
    agents: parser.agents.map((agent) => JSON.stringify(agent)),
  };
}

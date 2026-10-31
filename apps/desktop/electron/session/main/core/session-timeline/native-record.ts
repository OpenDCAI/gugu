import { nativeConversationUnread } from '../sessions/session-conversation-read';
import type { SessionTimelineResult } from './service';
import type { SessionTimeline } from '@gugu/session-core/session-record/contract';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { nativeAttachmentDataUrl, type NativeAttachmentRequest } from './native-attachment';

export function createNativeRecordReader(deps: {
  readSession(id: string): { runtime: string | null } | null | undefined;
  activeTurn(id: string): TranscriptTurn | null | undefined;
  withTimeline<T>(id: string, read: (timeline: SessionTimeline) => T | Promise<T>): Promise<SessionTimelineResult<T>>;
}) {
/** ACP phone views share the desktop's committed archive, including provider-generated identities. */
async function nativeRecord(input: { conversationId: string; before?: number; after?: number; tail?: boolean; limit?: number }): Promise<SessionTimelineResult<import('@gugu/session-core/session-record/contract').NativeSessionRecord>> {
  const row = deps.readSession(input.conversationId);
  if (!row || row.runtime !== 'acp') return { ok: false, error: { code: 'unsupported_runtime', message: '这条会话没有原生对话记录' } };
  return deps.withTimeline(input.conversationId, async () => {
    const { getStoredHistory } = await import('../sessions/session-turn-store');
    const limit = Math.min(100, Math.max(1, input.limit ?? 60));
    const prefix = `${input.conversationId}:turn:s`;
    const first = nativeConversationUnread(input.conversationId)[0];
    const firstSeq = first?.startsWith(prefix) ? Number(/^(\d+):/.exec(first.slice(prefix.length))?.[1]) : NaN;
    const before = input.before ?? (input.after !== undefined ? input.after + limit + 1 : !input.tail && Number.isSafeInteger(firstSeq) ? firstSeq + limit : undefined);
    const page = await getStoredHistory({ sessionId: input.conversationId, before, limit });
    const latest = await getStoredHistory({ sessionId: input.conversationId, limit: 1 });
    const selected = page.turns.map((turn, index) => ({ turn, origin: page.originTurnIds[index]! })).filter(({ turn }) => input.after === undefined || turn.seq > input.after);
    const turns = selected.map(one => one.turn);
    const latestStoredSeq = latest.turns.at(-1)?.seq ?? -1;
    const hasNewer = latestStoredSeq > (turns.at(-1)?.seq ?? input.after ?? -1);
    const { trimTurnsForTransport } = await import('@gugu/session-core/session-record');
    const active = deps.activeTurn(input.conversationId);
    return { ...page, turns, originTurnIds: selected.map(one => one.origin), latestStoredSeq, hasNewer, activeTurn: !hasNewer && active && !page.originTurnIds.includes(active.id) ? trimTurnsForTransport([active])[0]! : null };
  });
}

async function nativeToolImage(input: { conversationId: string; itemId: string; index: number }): Promise<SessionTimelineResult<import('@gugu/session-core/acp/client').ToolImageLookup>> {
  return deps.withTimeline(input.conversationId, async () => {
    const { findToolImage } = await import('@gugu/session-core/session-record');
    const active = deps.activeTurn(input.conversationId);
    if (active && input.itemId.startsWith(`${active.id}:`)) return findToolImage([active], input.itemId, input.index);
    const prefix = `${input.conversationId}:turn:s`;
    const suffix = input.itemId.startsWith(prefix) ? input.itemId.slice(prefix.length) : '';
    const seq = /^(\d+):/.exec(suffix)?.[1];
    if (seq === undefined) throw new Error('工具图片不属于这条原生会话');
    const { getStoredToolImage } = await import('../sessions/session-turn-store');
    return getStoredToolImage({ sessionId: input.conversationId, seq: Number(seq), itemId: input.itemId, index: input.index });
  });
}

async function nativeAttachment(input: NativeAttachmentRequest): Promise<SessionTimelineResult<string>> {
  return deps.withTimeline(input.conversationId, () => nativeAttachmentDataUrl(input, {
    readTurn: async () => {
      const active = deps.activeTurn(input.conversationId);
      if (active?.items.some(item => item.id === input.itemId)) return active;
      const prefix = `${input.conversationId}:turn:s`;
      const suffix = input.itemId.startsWith(prefix) ? input.itemId.slice(prefix.length) : '';
      const seq = /^(\d+):/.exec(suffix)?.[1];
      if (seq === undefined) return null;
      const { getStoredHistory } = await import('../sessions/session-turn-store');
      const page = await getStoredHistory({ sessionId: input.conversationId, before: Number(seq) + 1, limit: 1 });
      return page.turns.find(turn => turn.items.some(item => item.id === input.itemId)) ?? null;
    },
    download: async id => {
      const { getAcpRuntimeClient } = await import('../acp/runtime-process/host');
      const result = await (await getAcpRuntimeClient()).downloadAttachment({ id });
      if (!result.success) throw new Error('图片附件无法读取');
      return { ref: result.data.meta, data: await result.data.bytes() };
    },
  }));
}

return { snapshot: nativeRecord, image: nativeToolImage, attachment: nativeAttachment };
}

import { describe, expect, it } from 'vitest';
import { textFilePatch } from '@gugu/session-core/lib';
import { unit, type ItemSegmenter, type SegmentCtx } from '../core/units';
import type { ChatItem, FileChangeSummaryItem, OpenedOutputItem, TranscriptTurn } from '../model';
import { defaultChatTranslator as translate } from '../localization';
import { flattenTier } from './flatten';
import type { AgentActivityGroup } from './agent-activity';

const peer = 'user:11111111-1111-4111-8111-111111111111';
const incoming = (id: string): ChatItem => ({ kind: 'message', id, seq: 0, role: 'user', text:
  `<gugu_delivery route="chat" from="Peer" from_id="${peer}" from_type="agent" chat="group" chat_kind="group" msg="msg:${id}"><![CDATA[Check the files]]></gugu_delivery>` });
const edit = (id: string, path: string): ChatItem => ({ kind: 'diff', id, status: 'done', patches: [textFilePatch(path, null, 'hello')] });
const open = (id: string, path: string): ChatItem => ({ kind: 'mcp-tool-call', id, seq: 2, toolCallId: id,
  title: 'Open file', server: 'gugu', tool: 'session_open_in_tab', status: 'done', rawInput: JSON.stringify({ path }), outputText: JSON.stringify({ opened: true, path }) });
const turn = (id: string, items: ChatItem[]): TranscriptTurn => ({ id, seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: items as TranscriptTurn['items'] });
const segmenters = Object.fromEntries(['message', 'turn-process', 'tool-run', 'file-change-summary', 'opened-output', 'turn-completion'].map(kind => [kind,
  { kind, segment: item => [unit(kind, item, item, { key: 'self' })] } satisfies ItemSegmenter]));
const ctx = { caches: {}, active: false, agentConversation: true, translate, expanded: () => false,
  pendingToolCallIds: () => new Set(), terminalSnapshot: () => null, plan: () => null,
  actor: (id: string) => id === peer ? { id, type: 'agent', name: 'Peer' } : null } as unknown as SegmentCtx;
const summaries = (rows: ReturnType<typeof flattenTier>) => rows.filter(row => row.kind === 'file-change-summary');
const preview = (rows: ReturnType<typeof flattenTier>, path: string) => rows.find(row => row.kind === 'opened-output' && (row.data as OpenedOutputItem).output.kind === 'file' && ((row.data as OpenedOutputItem).output as { path: string }).path === path)!;

describe('activity owns the artifacts produced inside its segment', () => {
  it('keeps an edited card and a separate file preview inside one activity across turns', () => {
    const rows = flattenTier([turn('one', [incoming('in1'), edit('edit1', '/work/a.md'), open('open1', '/work/preview.html')]), turn('two', [incoming('in2')])], ctx, segmenters);
    const heads = rows.filter(row => row.kind === 'agent-activity');
    expect(heads).toHaveLength(1);
    expect((heads[0].data as AgentActivityGroup).events.reduce((n, event) => n + event.count, 0)).toBe(2);
    expect(summaries(rows)).toHaveLength(1);
    expect(summaries(rows)[0].activityFold).toBe(heads[0].id);
    expect(preview(rows, '/work/preview.html').activityFold).toBe(heads[0].id);
  });
  it('keeps ordinary artifacts visible when an own message divides the same turn', () => {
    const rows = flattenTier([turn('mixed', [incoming('in1'), edit('edit1', '/work/agent.md'), open('open1', '/work/agent.html'),
      { kind: 'message', id: 'own', seq: 3, role: 'user', text: 'Now edit my document' }, edit('edit2', '/work/own.md'), open('open2', '/work/own.html'),
      { kind: 'message', id: 'reply', seq: 4, role: 'assistant', text: 'Your document is ready' }])], ctx, segmenters);
    expect(summaries(rows)).toHaveLength(2);
    const byFile = (name: string) => summaries(rows).find(row => (row.data as FileChangeSummaryItem).files.some(file => file.path === name))!;
    expect(byFile('/work/agent.md').activityFold).toBeDefined();
    expect(byFile('/work/own.md').activityFold).toBeUndefined();
    expect((byFile('/work/own.md').data as FileChangeSummaryItem).files.map(file => file.path)).toEqual(['/work/own.md']);
    expect(preview(rows, '/work/agent.html').activityFold).toBeDefined();
    expect(preview(rows, '/work/own.html').activityFold).toBeUndefined();
    expect(rows.find(row => row.itemId === 'own')!.activityFold).toBeUndefined();
  });
});

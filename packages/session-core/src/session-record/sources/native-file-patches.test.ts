import { describe, expect, it } from 'vitest';
import { readClaudeRecord } from '@gugu/core/local/agent/transcriptSources/claudeCode';
import { AcpTranscriptParser } from '../../acp/reducer/parser';
import { projectToolContent } from '../../acp/models/tool-payload';
import { decodeClaudeRecord } from './claude-jsonl';

// The same result envelope observed from native Claude Write/Edit, with owned fixture paths.
const hunks = [
  { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' one\r', '-before\r', '+after\r', ' three\r'] },
  { oldStart: 90, oldLines: 1, newStart: 90, newLines: 1, lines: ['-tail', '+new tail', '\\ No newline at end of file'] },
];
const result = { type: 'user', uuid: 'result', message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'File updated.' }] },
  toolUseResult: { filePath: 'C:\\work\\file.txt', structuredPatch: hunks, originalFile: 'not used to rebuild the patch' } };

function projection(line: Record<string, unknown>) {
  const parser = new AcpTranscriptParser({ sessionId: 'native-patch' });
  parser.pushEvent({ kind: 'tool_call', toolCallId: 'edit', title: 'Edit', toolKind: 'edit', status: 'in_progress', parentToolCallId: null, locations: [] }, 1);
  for (const entry of decodeClaudeRecord(line, 'result')) if (entry.event) parser.pushEvent(entry.event, 2);
  const item = parser.activeTurn!.items[0]!;
  if (!('contentBlocks' in item)) throw new Error('Missing tool entity');
  const patches = projectToolContent(item.contentBlocks ?? []).diffs;
  const saved = JSON.parse(JSON.stringify(parser.snapshotState()));
  const restored = new AcpTranscriptParser({ sessionId: 'native-patch' });
  restored.restoreState(saved);
  expect(restored.activeTurn).toEqual(parser.activeTurn);
  return { item, patches };
}

describe('native recorded file facts', () => {
  it('retains located hunk lines, CR bytes, EOF markers and coordinates through replay and archive', () => {
    expect(readClaudeRecord(result).items[0]).toMatchObject({ fileChange: { path: 'C:\\work\\file.txt', hunks } });
    const { item, patches } = projection(result);
    expect(item).toMatchObject({ kind: 'patch-tool-call', toolCallId: 'edit', status: 'done' });
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ changes: [{ operation: 'modify', path: 'C:\\work\\file.txt' }], scope: 'file' });
    const body = hunks.map(h => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}\n`).join('');
    expect(patches[0]!.patch!.text.endsWith(body)).toBe(true);
    expect(patches[0]!.patch!.text).not.toContain('not used');
  });

  it('encodes the full native Write result only once and keeps an empty new file distinct', () => {
    for (const content of ['created\r\nno final newline', '']) {
      const { patches } = projection({ ...result, toolUseResult: { type: 'create', filePath: '/work/created', content, structuredPatch: [], originalFile: null } });
      expect(patches[0]).toMatchObject({ changes: [{ operation: 'add', path: '/work/created' }], scope: 'file' });
      if (content) expect(patches[0]!.patch!.text).toContain('+created\r\n+no final newline\n\\ No newline at end of file\n');
    }
  });

  it('does not assign one top-level file result to multiple result blocks or a failed operation', () => {
    const block = result.message.content[0]!;
    for (const content of [[block, { ...block, tool_use_id: 'other' }], [{ ...block, is_error: true }]]) {
      const record = readClaudeRecord({ ...result, message: { content } });
      expect(record.items.every(item => item.kind !== 'tool_result' || item.fileChange === undefined)).toBe(true);
    }
  });
});

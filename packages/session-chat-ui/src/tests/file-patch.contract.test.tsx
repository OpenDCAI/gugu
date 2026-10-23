/** @jsxImportSource solid-js */
import { describe, expect, it, vi } from 'vitest';
import { AcpTranscriptParser } from '../../../session-core/src/acp/reducer/parser';
import { decodeSessionUpdate } from '../../../session-core/src/acp/transport/decode';
import { filePatchFixtures } from '../../../session-core/src/acp/transport/file-patches.fixture';
import { changedFilePaths } from '@gugu/session-core/acp';
import { defaultChatTranslator } from '../localization';
import { diffUnitDef, patchDiffFromItem } from '../components/rows/tools/diff/diff.def';
import { makeContractCtx, renderAndMeasureUnit } from './contract';

function projected(block: unknown, pending = false) {
  const parser = new AcpTranscriptParser({ sessionId: 'patch-ui' });
  parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', kind: 'edit', content: [block], status: 'completed' } as never), 1);
  const item = parser.activeTurn?.items[0];
  if (item?.kind !== 'patch-tool-call') throw new Error('Expected one canonical patch entity');
  const measure = makeContractCtx({ width: 320 });
  const ui = patchDiffFromItem(item, { caches: measure.caches, expanded: () => false, active: false,
    plan: () => null, translate: defaultChatTranslator, pendingToolCallIds: () => new Set(pending ? ['edit'] : []),
    terminalSnapshot: () => null });
  return { ui, measure };
}

describe('source to canonical entity to patch UI', () => {
  it.each(filePatchFixtures)('preserves $name, including metadata and raw bytes', async ({ block }) => {
    const { ui, measure } = projected(block);
    const expected = [{ ...block, scope: 'file' }];
    expect(ui.patches).toEqual(expected);
    const onOpenFile = vi.fn();
    const reading = await renderAndMeasureUnit(diffUnitDef, ui, measure, host => {
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('button[data-patch-path]')];
      buttons.forEach(button => button.click());
      return { paths: buttons.length, rows: host.querySelectorAll('[data-patch-row]').length,
        hunks: host.querySelectorAll('[data-patch-row="hunk"]').length };
    }, { onOpenFile });
    expect(reading.dom).toBe(reading.computed);
    expect(reading.spill).toBeLessThanOrEqual(1);
    expect(reading.inspected.paths).toBe(changedFilePaths(ui.patches).length);
    expect(onOpenFile.mock.calls.map(([value]) => value.path)).toEqual(changedFilePaths(ui.patches));
    expect(ui.patches).toEqual(expected);
    if (block === filePatchFixtures[0].block) expect(reading.inspected.hunks).toBe(2);
    if (block === filePatchFixtures[4].block) expect(reading.inspected.rows).toBe(0);
  });

  it('uses exactly the same Windows destination and tool identity in preview and result', async () => {
    const block = filePatchFixtures[1].block;
    const calls: unknown[] = [];
    for (const pending of [true, false]) {
      const { ui, measure } = projected(block, pending);
      await renderAndMeasureUnit(diffUnitDef, ui, measure, host => {
        host.querySelector<HTMLButtonElement>('button[data-patch-path]')!.click();
        return {};
      }, { onOpenFile: value => calls.push(value) });
    }
    expect(calls).toEqual([
      { path: 'C:\\work\\new name.ts', itemId: expect.any(String), source: 'diff' },
      { path: 'C:\\work\\new name.ts', itemId: expect.any(String), source: 'diff' },
    ]);
    expect(calls[0]).toEqual(calls[1]);
  });
});

/**
 * @@@key-only-queries guard: an attachment bubble's cached query must not keep the pane that showed it. Before, a queryFn
 * written in the bubble closed over the bubble's whole render scope (its onOpenFile handler, and through it the panel's
 * state), and the module-level attachment cache kept it for minutes after the conversation was left — on the owner's account
 * ~600 detached nodes per opened group. Real bubbles, real React.
 */
import { createNode, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { afterEach, expect, it } from 'vitest';
import { cdp } from '@vitest/browser/context';
import { useState } from 'react';
import { parseAttachmentContent, type ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels';
import { MediaAttachmentBubble } from '@/components/chat/MediaAttachmentBubble';
import { attachmentQueryClient } from '@/lib/attachmentQueryClient';

let harness: ReturnType<typeof createReactHarness> | null = null;
afterEach(() => { harness?.cleanup(); harness = null; attachmentQueryClient.clear(); });

const file = (n: number) => parseAttachmentContent(`[附件] report-${n}.pdf (application/pdf)\n[Size] 1024\n[Kind] file`,
  { file_item_id: `item-${n}`, file_version: 2 }) as ParsedAttachment;

/** A conversation pane: it keeps its list element in state and hands the bubble a handler that uses it, as the panel does. */
function Pane({ n, onList }: { n: number; onList: (element: HTMLElement) => void }) {
  const [list, setList] = useState<HTMLElement | null>(null);
  return createNode('div', { ref: (element: HTMLElement | null) => { if (element) { setList(element); onList(element); } } },
    ...Array.from({ length: 200 }, (_, row) => createNode('p', { key: row }, `row ${row}`)),
    createNode(MediaAttachmentBubble, { meta: file(n), messageId: `m-${n}`, isMine: false, onOpenFile: () => list?.scrollIntoView() }));
}

/** Collect the way DevTools does: a full GC from the profiler, outside any JS stack. */
async function collect(): Promise<void> {
  for (let i = 0; i < 3; i++) { await cdp().send('HeapProfiler.collectGarbage'); await new Promise((resolve) => setTimeout(resolve, 20)); }
}

it('a left conversation is collected even though its attachment state stays cached', async () => {
  const lists: WeakRef<HTMLElement>[] = []; const seen = new WeakSet<HTMLElement>();
  harness = createReactHarness();
  for (let n = 0; n < 12; n++) {
    await renderWithAppProviders(harness, createNode(Pane, { key: n, n, onList: (element: HTMLElement) => { if (!seen.has(element)) { seen.add(element); lists.push(new WeakRef(element)) } } }));
  }
  await renderWithAppProviders(harness, createNode('div', null));
  // The cache still holds a query per attachment shown (that is its job) ...
  expect(attachmentQueryClient.getQueryCache().findAll({ queryKey: ['attachment-state'] }).length).toBeGreaterThanOrEqual(12);
  // ... but none of the panes that showed them. React keeps the last two committed trees (current and alternate fibers),
  // so the two panes shown last may still be referenced for a while under load (seen on CI with index 10 and 11); every
  // earlier one must be gone. The parent kept all twelve, through queryFn, so this still fails without the fix.
  const kept = () => lists.map((ref, index) => ref.deref() === undefined ? null : index).filter((index) => index !== null);
  const leftEarlier = () => kept().filter((index) => index! < 10);
  for (let round = 0; round < 8 && leftEarlier().length > 0; round++) {
    await renderWithAppProviders(harness, createNode('div', { key: round }));
    await collect();
  }
  expect({ shown: lists.length, kept: leftEarlier() }).toEqual({ shown: 12, kept: [] });
});

import { stack } from '@session-chat/core/compose';
import type { StackLayout } from '@session-chat/core/compose';
import type { Measured, MeasureCtx } from '@session-chat/core/define';
import type { BlockLeafLayout } from '@session-chat/core/layout/layout-types';
import type { Block } from '@session-chat/core/markdown/document';
import { collapse } from '@session-chat/core/spacing';
import { BLOCK_REGISTRY } from './block-registry';

// ── Per-block memo ────────────────────────────────────────────────────────────
//
// WeakMap keyed by Block object. Skips re-measures for unchanged blocks inside
// streaming rows. Fingerprint includes measureEpoch, width, and collapsed state
// so the cache is invalidated correctly on any relevant change.

const blockMemo = new WeakMap<Block, { fingerprint: string; result: Measured<BlockLeafLayout> }>();

export function measureBlockCached(block: Block, ctx: MeasureCtx): Measured<BlockLeafLayout> {
  const fingerprint = `${ctx.measureEpoch ?? 0}|${ctx.width}|${ctx.isCollapsed(block.id)}`;
  const cached = blockMemo.get(block);
  if (cached?.fingerprint === fingerprint) return cached.result;

  // BLOCK_REGISTRY is typed at boundary
  const result: Measured<BlockLeafLayout> = BLOCK_REGISTRY[block.kind].measure(block as any, ctx);
  blockMemo.set(block, { fingerprint, result });
  return result;
}

/** Zero-height placeholder: a collapsed block keeps its id (and its place) but contributes no height. */
function collapsedLayout(block: Block): BlockLeafLayout {
  switch (block.kind) {
    case 'html':
      return { kind: 'html', id: block.id, top: 0, height: 0, contentWidth: 0, html: '', raw: block };
    case 'code':
      return { kind: 'code', id: block.id, top: 0, height: 0, contentWidth: 0, lines: [], raw: block };
    case 'mermaid':
      return { kind: 'mermaid', id: block.id, top: 0, height: 0, contentWidth: 0, source: block.source, raw: block };
    case 'svg':
      return { kind: 'svg', id: block.id, top: 0, height: 0, contentWidth: 0, raw: block };
    case 'math':
      return {
        kind: 'math',
        id: block.id,
        top: 0,
        height: 0,
        contentWidth: 0,
        html: '',
        naturalWidth: 0,
        fontSize: 0,
        raw: block,
      };
  }
}

// ── layoutBlockStack ─────────────────────────────────────────────────────────

export type BlockStackOpts = {
  padY?: number;
  isCollapsed?: (id: string) => boolean;
};

export function layoutBlockStack(
  blocks: Block[],
  ctx: MeasureCtx,
  opts: BlockStackOpts = {}
): Measured<StackLayout> {
  const { padY = 0, isCollapsed = () => false } = opts;

  const children: { id: string; measured: Measured<BlockLeafLayout> }[] = [];
  let visibleCount = 0;

  for (const block of blocks) {
    if (isCollapsed(block.id)) {
      // Zero-height placeholder keeps block IDs stable but contributes no height.
      const zeroMeasured: Measured<BlockLeafLayout> = {
        height: 0,
        width: 0,
        layout: collapsedLayout(block),
      };
      children.push({ id: block.id, measured: zeroMeasured });
      continue;
    }

    children.push({ id: block.id, measured: measureBlockCached(block, ctx) });
    visibleCount++;
  }

  // Resolve each seam gap via margin-collapse: max(prev.margin.bottom, cur.margin.top).
  // Margins are fetched per-block (not per-kind) so prose can vary by variant.
  // All block defs declare margin — no fallback needed.
  const gapFn = (idx: number): number => {
    if (isCollapsed(blocks[idx].id)) return 0;
    let prevBlock: Block | null = null;
    for (let j = idx - 1; j >= 0; j--) {
      if (!isCollapsed(blocks[j].id)) {
        prevBlock = blocks[j];
        break;
      }
    }
    if (prevBlock === null) return 0;
    const prev = BLOCK_REGISTRY[prevBlock.kind];
    const cur = BLOCK_REGISTRY[blocks[idx].kind];
    // block kind matches def at runtime
    return collapse((prev as any).margin(prevBlock).bottom, (cur as any).margin(blocks[idx]).top);
  };

  return stack(children, { padY, gap: visibleCount > 1 ? gapFn : 0 });
}

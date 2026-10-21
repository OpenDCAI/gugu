/** @jsxImportSource solid-js */
import { defineBlock } from '@session-chat/components/rows/markdown/block-def';
import type { Measured, MeasureCtx } from '@session-chat/core/define';
import type { MathLeafLayout } from '@session-chat/core/layout/layout-types';
import { reserveHeight } from '@session-chat/core/layout/reserve-height';
import type { MathBlock } from '@session-chat/core/markdown/document';
import { Formula } from './Formula';
import { horizontalScrollbarThickness, measureDisplayMath } from './layout';

/** Matches the code block's breathing room, so the two artifact blocks agree. */
const MATH_BLOCK_PAD_Y = 8;

export const mathBlockDef = defineBlock<MathBlock, MathLeafLayout>({
  kind: 'math',
  margin: () => ({ top: 8, bottom: 8 }),

  measure(block: MathBlock, ctx: MeasureCtx): Measured<MathLeafLayout> {
    const fontSize = ctx.theme.fonts.body.size;
    const innerWidth = Math.max(1, ctx.width);
    const typeset = measureDisplayMath(block.tex, fontSize, innerWidth);
    // An over-wide formula gets a scroll track, and on platforms that draw a
    // real one that track is height the formula no longer has.
    const scrollTrack = typeset.width > innerWidth ? horizontalScrollbarThickness() : 0;

    const height = reserveHeight({
      content: typeset.height + scrollTrack,
      padY: MATH_BLOCK_PAD_Y,
    });

    const layout: MathLeafLayout = {
      kind: 'math',
      id: block.id,
      top: 0,
      height,
      contentWidth: ctx.width,
      html: typeset.html,
      naturalWidth: typeset.width,
      fontSize,
      raw: block,
    };
    return { height, width: ctx.width, layout };
  },

  Render(props: { node: Measured<MathLeafLayout> }) {
    return <Formula block={props.node.layout} />;
  },
});

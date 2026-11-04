/** @jsxImportSource solid-js */
import { defineBlock } from '@session-chat/components/rows/markdown/block-def';
import type { Measured, MeasureCtx } from '@session-chat/core/define';
import type { CodeLeafLayout, SvgLeafLayout } from '@session-chat/core/layout/layout-types';
import type { SvgBlock } from '@session-chat/core/markdown/document';
import { svgFigure } from '@session-chat/core/svg/figure';
import { codeBlockDef } from '../code/code.def';
import { SvgFigureView } from './SvgFigureView';

/**
 * A ```svg fence: drawn at its viewBox size, never wider than the row. One that cannot be drawn
 * (`svgFigure` says why) is measured and painted as the code block it is.
 */
export const svgBlockDef = defineBlock<SvgBlock, SvgLeafLayout | CodeLeafLayout>({
  kind: 'svg',
  margin: () => ({ top: 8, bottom: 8 }),

  measure(block: SvgBlock, ctx: MeasureCtx): Measured<SvgLeafLayout | CodeLeafLayout> {
    // Size only: colours do not change the box, so the theme is read when painting.
    const figure = svgFigure(block.source, {});
    if (!figure.ok) return codeBlockDef.measure({ kind: 'code', id: block.id, code: block.source, lang: 'svg' }, ctx);
    const width = Math.min(figure.width, ctx.width);
    const height = Math.round((width * figure.height) / figure.width);
    const layout: SvgLeafLayout = { kind: 'svg', id: block.id, top: 0, height, contentWidth: width, raw: block };
    return { height, width, layout };
  },

  Render(props: { node: Measured<SvgLeafLayout | CodeLeafLayout> }) {
    const layout = props.node.layout;
    if (layout.kind === 'code') return codeBlockDef.Render({ node: props.node as Measured<CodeLeafLayout> });
    return <SvgFigureView block={layout} />;
  },
});

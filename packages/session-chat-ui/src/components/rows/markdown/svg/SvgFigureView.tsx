/** @jsxImportSource solid-js */
import { BlockFrame } from '@session-chat/components/engine/block-frame';
import type { SvgLeafLayout } from '@session-chat/core/layout/layout-types';
import { subscribeMermaidTheme } from '@session-chat/core/mermaid/render';
import { svgFigure, svgPalette } from '@session-chat/core/svg/figure';
import { createMemo, createSignal, onCleanup } from 'solid-js';
import { svgFigureImage } from './svg.css';

/** The figure in the box its def measured; redrawn when the host's light/dark truth flips. */
export function SvgFigureView(props: { block: SvgLeafLayout }) {
  const [themeFlips, setThemeFlips] = createSignal(0);
  onCleanup(subscribeMermaidTheme(() => setThemeFlips((n) => n + 1)));
  const src = createMemo(() => {
    themeFlips();
    const figure = svgFigure(props.block.raw.source, svgPalette(document.documentElement));
    return figure.ok ? figure.src : '';
  });
  return (
    <BlockFrame layout={props.block}>
      <img src={src()} width={props.block.contentWidth} height={props.block.height} alt="" draggable={false} class={svgFigureImage} />
    </BlockFrame>
  );
}

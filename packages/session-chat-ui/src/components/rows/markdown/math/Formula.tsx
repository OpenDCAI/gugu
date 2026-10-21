/** @jsxImportSource solid-js */
/**
 * Formula — Solid component painting a display-math block.
 *
 * Unlike Mermaid, there is no placeholder-then-swap: KaTeX typesetting is
 * synchronous and already done — the HTML held in the layout is the very output
 * whose box the measurement tier read. Rendering anything else first would put
 * a differently-sized thing inside a box reserved for this one.
 *
 * (Named Formula, not Math, so it cannot shadow the global `Math` at any call
 * site that also does arithmetic.)
 */

import { BlockFrame } from '@session-chat/components/engine/block-frame';
import type { MathLaidOut } from '@session-chat/core/layout/layout-types';
import { mathBlock, mathContent } from './math.css';

export type FormulaProps = {
  block: MathLaidOut;
};

export function Formula(props: FormulaProps) {
  return (
    <BlockFrame layout={props.block}>
      <div class={mathBlock} style={{ 'font-size': `${props.block.fontSize}px` }}>
        <span class={mathContent} innerHTML={props.block.html} />
      </div>
    </BlockFrame>
  );
}

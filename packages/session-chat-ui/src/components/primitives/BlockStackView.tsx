/** @jsxImportSource solid-js */
import { BLOCK_REGISTRY } from '@session-chat/components/rows/markdown/block-registry';
import type { StackLayout } from '@session-chat/core/compose';
import type { Measured } from '@session-chat/core/define';
import type { BlockLeafLayout } from '@session-chat/core/layout/layout-types';
import { For, createMemo } from 'solid-js';
import { Dynamic } from 'solid-js/web';

function BlockLeafRender(props: { node: Measured<BlockLeafLayout> }) {
  const def = BLOCK_REGISTRY[props.node.layout.kind];
  if (!def) return null;
  // oxlint-disable-next-line typescript/no-explicit-any -- registry boundary
  return <Dynamic component={def.Render} node={props.node as any} />;
}

export type BlockStackViewProps = {
  node: Measured<StackLayout>;
};

export function BlockStackView(props: BlockStackViewProps) {
  const placed = () => props.node.layout.placed;
  const tops = createMemo(() => new Map(placed().map((p) => [p.child, p.top])));
  return (
    <div style={{ position: 'relative', height: `${props.node.height}px`, width: '100%' }}>
      {/*
       * Key by the measured child. Block defs snapshot props.node.layout at
       * mount, so a block whose layout changed must remount — and it does: a
       * grown or re-measured block is a new Measured object. An unchanged block
       * gets the same object back from measureBlockCached, so its row and DOM
       * survive the chunk and only its position follows the stack.
       */}
      <For each={placed().map((p) => p.child)}>
        {(child) => (
          <div
            style={{
              position: 'absolute',
              top: `${tops().get(child)}px`,
              left: 0,
              right: 0,
              height: `${child.height}px`,
            }}
          >
            <BlockLeafRender node={child as Measured<BlockLeafLayout>} />
          </div>
        )}
      </For>
    </div>
  );
}

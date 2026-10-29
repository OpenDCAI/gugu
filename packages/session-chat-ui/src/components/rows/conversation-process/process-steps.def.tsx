/** @jsxImportSource solid-js */
import { For, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { CONVERSATION_PREVIEW_MAX_H } from '@session-chat/components/engine/row-metrics';
import type { MeasureCtx } from '@session-chat/core/define';
import { defineUnit, type RenderUnit, type UnitDef } from '@session-chat/core/units';
import * as styles from './process-steps.css';

type ProcessSteps = { id: string; units: readonly RenderUnit[] };
type Registry = Record<string, UnitDef<unknown, Record<string, number>>>;
const widthRatio = .86;
const followThreshold = 24;

/** Registry supplied lazily: leaves keep their own exact measure and render contracts. */
export function createProcessStepsUnitDef(registry: () => Registry) {
  const childContext = (unit: RenderUnit, ctx: MeasureCtx): MeasureCtx => ({ ...ctx,
    width: Math.max(0, ctx.width * widthRatio - 2 * (unit.chrome?.insetX ?? 0)) });
  const height = (unit: RenderUnit, ctx: MeasureCtx) => {
    const def = registry()[unit.kind];
    return unit.gapBefore + def.measure(unit.data, childContext(unit, ctx), def.vars ?? {});
  };
  const contentHeight = (data: ProcessSteps, ctx: MeasureCtx) => data.units.reduce((sum, unit) => sum + height(unit, ctx), 0);
  return defineUnit<ProcessSteps>({
    kind: 'conversation-process-steps', margin: { top: 0, bottom: 0 },
    estimate: () => CONVERSATION_PREVIEW_MAX_H,
    measure: (data, ctx) => Math.min(CONVERSATION_PREVIEW_MAX_H, contentHeight(data, ctx)),
    Render(props) {
      const commands = useCommands();
      let viewport!: HTMLDivElement;
      let disposed = false;
      const [scrolled, setScrolled] = createSignal(false);
      const ctx = () => props.ctx.measureCtx!();
      const total = createMemo(() => contentHeight(props.data, ctx()));
      const remember = () => {
        if (disposed || !viewport.isConnected) return;
        const memory = ctx().caches.processScrollPositions;
        memory.set(props.data.id, { top: viewport.scrollTop,
          atEnd: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < followThreshold });
        setScrolled(viewport.scrollTop > 0);
      };
      createEffect(() => {
        const id = props.data.id;
        const memory = ctx().caches.processScrollPositions;
        total();
        const previous = memory.get(id);
        // Child DOM and the capped height must update before writing scrollTop.
        queueMicrotask(() => {
          if (disposed || !viewport?.isConnected || id !== props.data.id) return;
          viewport.scrollTop = !previous || previous.atEnd ? viewport.scrollHeight : previous.top;
          remember();
        });
      });
      onCleanup(() => { disposed = true; });
      return <div class={styles.root}>
        <div ref={viewport} class={styles.viewport} data-slot="conversation-process-steps" data-process-id={props.data.id}
          style={{ height: `${Math.min(CONVERSATION_PREVIEW_MAX_H, total())}px` }} onScroll={remember}>
          <For each={props.data.units}>{unit => {
            const def = () => registry()[unit.kind];
            const inset = () => unit.chrome?.insetX ?? 0;
            return <div data-process-step data-item-id={unit.itemId} data-row-kind={unit.kind}
              classList={{ 'msg-src-flash': commands().flashMessageId === unit.itemId }}
              style={{ 'padding-top': `${unit.gapBefore}px`, 'padding-inline': `${inset()}px` }}>
              <Dynamic component={def().Render} data={unit.data} vars={def().vars ?? {}}
                ctx={{ viewState: props.ctx.viewState, measureCtx: () => childContext(unit, ctx()) }} />
            </div>;
          }}</For>
        </div>
        <div class={styles.fade} data-slot="conversation-process-top-fade" aria-hidden="true"
          style={{ opacity: scrolled() ? 1 : 0 }} />
      </div>;
    },
  });
}

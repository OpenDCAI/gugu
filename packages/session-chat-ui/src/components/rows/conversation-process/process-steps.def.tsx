/** @jsxImportSource solid-js */
import { For, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { PROCESS_COMPLETED_MAX_H, PROCESS_PREVIEW_MAX_H } from '@session-chat/components/engine/row-metrics';
import type { MeasureCtx } from '@session-chat/core/define';
import { defineUnit, type RenderUnit, type UnitDef } from '@session-chat/core/units';
import { buildChatTheme, toThemeVars } from '@session-chat/core/config';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { vars as themeVars } from '@session-chat/styles/theme.css';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import * as styles from './process-steps.css';

type ProcessSteps = { id: string; live: boolean; units: readonly RenderUnit[] };
type Registry = Record<string, UnitDef<unknown, Record<string, number>>>;
const widthRatio = .86;
const followThreshold = 24;

/** Registry supplied lazily: leaves keep their own exact measure and render contracts. */
export function createProcessStepsUnitDef(registry: () => Registry) {
  const processTheme = (ctx: MeasureCtx) => {
    const config = ctx.theme.config;
    const roles = Object.fromEntries(Object.entries(config.roles).map(([key, role]) => [key, { ...role, size: 14, lineHeight: 20 }]));
    return buildChatTheme({ ...config, fonts: { ...config.fonts, sans: ['system-ui', '-apple-system', 'sans-serif'] }, roles: roles as typeof config.roles }, ctx.theme.layout);
  };
  const maxHeight = (data: ProcessSteps) => data.live ? PROCESS_PREVIEW_MAX_H : PROCESS_COMPLETED_MAX_H;
  const indent = (unit: RenderUnit) => unit.folds?.some(gate => gate.id.includes(':run:')) ? 20 : 0;
  const childVars = (def: UnitDef<unknown, Record<string, number>>) => ({ ...def.vars, ...('rowH' in (def.vars ?? {}) ? { rowH: 32 } : {}) });
  const childContext = (unit: RenderUnit, ctx: MeasureCtx): MeasureCtx => ({ ...ctx,
    theme: processTheme(ctx), width: Math.max(0, ctx.width * widthRatio - indent(unit)) });
  const height = (unit: RenderUnit, ctx: MeasureCtx) => {
    const def = registry()[unit.kind];
    return def.measure(unit.data, childContext(unit, ctx), childVars(def));
  };
  const contentHeight = (data: ProcessSteps, ctx: MeasureCtx) => data.units.reduce((sum, unit) => sum + height(unit, ctx), 0);
  return defineUnit<ProcessSteps>({
    kind: 'conversation-process-steps', margin: { top: 0, bottom: 0 },
    estimate: () => PROCESS_PREVIEW_MAX_H,
    measure: (data, ctx) => 6 + Math.min(maxHeight(data), contentHeight(data, ctx)),
    Render(props) {
      const commands = useCommands();
      let viewport!: HTMLDivElement;
      let disposed = false;
      const [scrolled, setScrolled] = createSignal(false);
      const ctx = () => props.ctx.measureCtx!();
      const memoryKey = () => `${props.data.id}:${props.data.live ? 'live' : 'done'}`;
      const total = createMemo(() => contentHeight(props.data, ctx()));
      const remember = () => {
        if (disposed || !viewport.isConnected) return;
        const memory = ctx().caches.processScrollPositions;
        memory.set(memoryKey(), { top: viewport.scrollTop,
          atEnd: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < followThreshold });
        setScrolled(viewport.scrollTop > 2);
      };
      createEffect(() => {
        const key = memoryKey();
        const live = props.data.live;
        const memory = ctx().caches.processScrollPositions;
        total();
        const previous = memory.get(key);
        // Child DOM and the capped height must update before writing scrollTop.
        queueMicrotask(() => {
          if (disposed || !viewport?.isConnected || key !== memoryKey()) return;
          viewport.scrollTop = live && (!previous || previous.atEnd) ? viewport.scrollHeight : previous?.top ?? 0;
          remember();
        });
      });
      onCleanup(() => { disposed = true; });
      return <ThemeContext.Provider value={() => processTheme(ctx())}><div class={styles.root} style={assignInlineVars(Object.fromEntries(Object.entries(toThemeVars(processTheme(ctx()).config)).map(([key, value]) => [themeVars[key as keyof typeof themeVars], value])))}>
        <div ref={viewport} class={styles.viewport} data-slot="conversation-process-steps" data-process-id={props.data.id} data-live={props.data.live}
          style={{ height: `${Math.min(maxHeight(props.data), total())}px` }} onScroll={remember}>
          <For each={props.data.units}>{unit => {
            const def = () => registry()[unit.kind];
            return <div data-process-step data-item-id={unit.itemId} data-row-kind={unit.kind}
              classList={{ 'msg-src-flash': commands().flashMessageId === unit.itemId }}
              style={{ 'padding-left': `${indent(unit)}px` }}>
              <Dynamic component={def().Render} data={unit.data} vars={childVars(def())}
                ctx={{ viewState: props.ctx.viewState, measureCtx: () => childContext(unit, ctx()) }} />
            </div>;
          }}</For>
        </div>
        <div class={styles.fade} data-slot="conversation-process-top-fade" aria-hidden="true"
          style={{ opacity: props.data.live && scrolled() ? 1 : 0 }} />
      </div></ThemeContext.Provider>;
    },
  });
}

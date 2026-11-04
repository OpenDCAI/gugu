/** @jsxImportSource solid-js */
/**
 * contract — shared harness for browser measurement contract tests.
 *
 * Each contract test mounts the real Render component in a fixed-width
 * container and returns both def.measure(data, ctx) and the same-layer root
 * element's actual offsetHeight.
 *
 * Usage:
 *   import { makeContractCtx, renderAndMeasureUnit } from '@session-chat/tests/contract';
 *
 *   const ctx = makeContractCtx({ width: 640 });
 *   const { computed, dom } = await renderAndMeasureUnit(def, item, ctx);
 *   expect(computed).toBe(dom);
 *
 * Tolerance: heights must match exactly (integer px). Sub-pixel disagreements
 * are bugs in the measurement model.
 */

import '@gugu/session-shared/markdown.css';
import type { ChatCommands } from '@session-chat/commands';
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { ChatTranslationProvider, defaultChatTranslator } from '@session-chat/localization';
import type { BlockDef } from '@session-chat/components/rows/markdown/block-def';
import { createChatCaches } from '@session-chat/core/caches';
import type { ThemeVarKey } from '@session-chat/core/config';
import type { MeasureCtx, Measured, RenderCtx } from '@session-chat/core/define';
import type { BlockLeafLayout } from '@session-chat/core/layout/layout-types';
import type { Block } from '@session-chat/core/markdown/document';
import type { ChatTheme } from '@session-chat/core/theme';
import { DEFAULT_THEME } from '@session-chat/core/theme';
import type { UnitDef } from '@session-chat/core/units';
import { vars } from '@session-chat/styles/theme.css';
import { type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach } from 'vitest';

export type ContractCtx = MeasureCtx;

export type HeightContractReading = {
  computed: number;
  dom: number;
  renderedElements: number;
  /**
   * Widest px any rendered descendant sticks out past the fixed-width host, on
   * either edge. Read by comparing bounding-rect edges rather than
   * scrollWidth/clientWidth, because an `overflow: visible` spill does not
   * always show up in scrollWidth — the two readings are not interchangeable.
   */
  spill: number;
  /**
   * Whatever the caller's `inspect` hook read off the still-mounted host.
   * Empty when no hook was passed. Contracts that need a reading the root's
   * border-box height cannot express — a clipped inner stack keeps the root
   * exactly on its measured height however squashed its contents are — put it
   * here instead of re-implementing the mount.
   */
  inspected: Record<string, number>;
};

/** Reads taken off the live host after paint, before it is torn down. */
export type ContractInspector = (host: HTMLElement) => Record<string, number>;

/**
 * Build a MeasureCtx for contract tests.
 * Defaults: theme = DEFAULT_THEME, width = 640, no collapsed items.
 */
export function makeContractCtx(opts: {
  width?: number;
  theme?: ChatTheme;
  isCollapsed?: (id: string) => boolean;
  expanded?: (id: string) => boolean;
  expandedId?: string | null;
}): ContractCtx {
  return {
    theme: opts.theme ?? DEFAULT_THEME,
    width: opts.width ?? 640,
    isCollapsed: opts.isCollapsed ?? (() => false),
    expanded: opts.expanded ?? (() => false),
    caches: createChatCaches(),
    expandedId: opts.expandedId,
  };
}

/**
 * Mount a native `UnitDef.Render` in a fixed-width container, wait one rAF,
 * then return both the computed height (from `def.measure`) and the actual DOM height.
 *
 * The `renderCtx` supplied to the Render has:
 *   - `viewState.isCollapsed` = `ctx.isCollapsed` (matches the Lane A inputs)
 *   - `measureCtx` = `() => measureCtx` (so native Renders can access theme/width/caches)
 *
 * Note: `expanded(id) = isCollapsed(id)` mirrors the native UnitRow path, where
 * inverted-mode composites (thinking / plan / file-op) treat isCollapsed=true as
 * "expanded".
 */
export async function renderAndMeasureUnit<D, V extends Record<string, number>>(
  def: UnitDef<D, V>,
  data: D,
  ctx: ContractCtx,
  inspect?: ContractInspector,
  /**
   * Host callbacks for rows whose controls only exist when the host wired them
   * (turn-outcome's restore action, the user card's stop button). Omitted =
   * `{}`, which is the *product-meaningful* default: a row that renders no
   * control without a callback must also measure the same either way, and
   * leaving this out is how that half of the contract gets read.
   */
  commands: ChatCommands = {}
): Promise<HeightContractReading> {
  // Mirror the native UnitRow path: expanded(id) = isCollapsed(id).
  const measureCtx: MeasureCtx = {
    ...ctx,
    commands: ctx.commands ?? commands,
    expanded: ctx.isCollapsed,
  };
  const defVars = (def.vars ?? {}) as V;
  const computed = def.measure(data, measureCtx, defVars);
  const renderCaches = createChatCaches();
  const renderMeasureCtx: MeasureCtx = { ...measureCtx, caches: renderCaches };
  const renderCtx: RenderCtx = {
    viewState: { isCollapsed: ctx.isCollapsed },
    measureCtx: () => renderMeasureCtx,
  };

  const host = createContractHost(ctx);
  document.body.appendChild(host);

  let dispose: (() => void) | undefined;

  try {
    // JSX typed per-def; safe at boundary
    const Comp = def.Render as (p: any) => JSX.Element;
    dispose = render(
      () => (
        <ThemeContext.Provider value={() => ctx.theme}>
          <CachesContext.Provider value={renderCaches}>
            <ChatTranslationProvider value={{ translate: defaultChatTranslator, locale: () => 'en-US' }}>
              <CommandsContext.Provider value={() => commands}>
                <Comp data={data} ctx={renderCtx} vars={defVars} />
              </CommandsContext.Provider>
            </ChatTranslationProvider>
          </CachesContext.Provider>
        </ThemeContext.Provider>
      ),
      host
    );

    await nextPaint();

    const child = host.firstElementChild as HTMLElement | null;
    return {
      computed,
      dom: child?.offsetHeight ?? 0,
      renderedElements: host.querySelectorAll('*').length,
      spill: measureSpill(host),
      inspected: inspect?.(host) ?? {},
    };
  } finally {
    dispose?.();
    document.body.removeChild(host);
  }
}

/** Mount a block def and read the border-box height of its rendered BlockFrame. */
export async function renderAndMeasureBlock<B extends Block, L extends BlockLeafLayout>(
  def: BlockDef<B, L>,
  block: B,
  ctx: ContractCtx,
  inspect?: ContractInspector
): Promise<HeightContractReading> {
  const measured = def.measure(block, ctx);
  const host = createContractHost(ctx);
  // Production BlockFrames are absolutely positioned inside BlockStackView's
  // relative root. Recreate that containing block so width-derived geometry
  // (notably Mermaid's aspect ratio) reads the contract width, not the viewport.
  host.style.position = 'relative';
  document.body.appendChild(host);

  let dispose: (() => void) | undefined;

  try {
    const Comp = def.Render as (props: { node: Measured<L> }) => JSX.Element;
    const caches = ctx.caches;
    dispose = render(
      () => (
        <ThemeContext.Provider value={() => ctx.theme}>
          <CachesContext.Provider value={caches}>
            <Comp node={measured} />
          </CachesContext.Provider>
        </ThemeContext.Provider>
      ),
      host
    );

    await nextPaint();

    const child = host.firstElementChild as HTMLElement | null;
    return {
      computed: measured.height,
      dom: child?.offsetHeight ?? 0,
      renderedElements: host.querySelectorAll('*').length,
      spill: measureSpill(host),
      inspected: inspect?.(host) ?? {},
    };
  } finally {
    dispose?.();
    document.body.removeChild(host);
  }
}

/**
 * Widest horizontal spill past the host box, in px, across every rendered
 * descendant. Both edges are compared: a right-edge-only check reads clean for
 * content pushed out to the left.
 */
export function measureSpill(host: HTMLElement): number {
  const bounds = host.getBoundingClientRect();
  let worst = 0;
  for (const element of host.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    let left = rect.left;
    let right = rect.right;
    // A transformed decoration can extend beyond its box while its painted
    // pixels stay clipped. Measure the visible extent, including every clip.
    for (let parent = element.parentElement; parent && parent !== host; parent = parent.parentElement) {
      if (['hidden', 'clip', 'scroll', 'auto'].includes(getComputedStyle(parent).overflowX)) {
        const clip = parent.getBoundingClientRect();
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
      }
    }
    if (right > left) worst = Math.max(worst, right - bounds.right, bounds.left - left);
  }
  return worst;
}

/**
 * How many px narrower `el` is laid out than its own text wants, as a fraction.
 *
 * ❌ `scrollWidth - clientWidth`: both are rounded integers, so a label squeezed by
 * 0.09px reads 28 vs 28 — while a `nowrap` + `ellipsis` label already paints 「执…」
 * at any loss above zero (2026-10-16). The natural width is read off a clone in the
 * same parent (same font, same class), taken out of the flex line so nothing sizes it.
 */
export function labelShortfall(el: HTMLElement): number {
  const probe = el.cloneNode(true) as HTMLElement;
  probe.style.cssText = 'position:absolute;visibility:hidden;width:max-content;max-width:none';
  el.parentElement?.appendChild(probe);
  const natural = probe.getBoundingClientRect().width;
  probe.remove();
  return natural - el.getBoundingClientRect().width;
}

/**
 * The line a transcript text run is set on: `.gg-md--compact`'s rhythm at `size` px, read off a bare element
 * so the contracts compare against the stylesheet rather than a restated ratio.
 */
export function compactLineHeight(size: number): number {
  const probe = document.createElement('div');
  probe.className = 'gg-md gg-md--compact';
  probe.style.fontSize = `${size}px`;
  document.body.appendChild(probe);
  const lineHeight = Number.parseFloat(getComputedStyle(probe).lineHeight);
  probe.remove();
  return lineHeight;
}

function createContractHost(ctx: ContractCtx): HTMLDivElement {
  const host = document.createElement('div');
  host.dataset.contractHost = '';
  host.style.width = `${ctx.width}px`;

  for (const key of Object.keys(ctx.theme.themeVars) as ThemeVarKey[]) {
    const ref = String(vars[key]);
    const property = ref.startsWith('var(') ? ref.slice(4, -1) : ref;
    host.style.setProperty(property, ctx.theme.themeVars[key]);
  }

  return host;
}

async function nextPaint(): Promise<void> {
  await document.fonts.ready;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

// Auto-cleanup containers after each test (belt-and-suspenders).
afterEach(() => {
  document.querySelectorAll('[data-contract-host]').forEach((el) => el.remove());
});

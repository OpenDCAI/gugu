/** @jsxImportSource solid-js */
/**
 * Mermaid — Solid component rendering a MermaidLaidOut block.
 *
 * Renders a plain placeholder first (synchronous), then swaps to an SVG
 * rendered by official mermaid, started on an idle callback (mirroring
 * Code.tsx / Shiki). The SVG is drawn in the host's light/dark theme and
 * redrawn once when that theme flips.
 *
 * The container is fixed at a 21:9 aspect ratio (height pre-computed in
 * mermaid.def.tsx from the measured width). On click the host's
 * onViewMermaid command is fired, allowing the application to open a
 * full-size diagram viewer.
 */

import { useCaches } from '@session-chat/components/contexts/CachesContext';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { BlockFrame } from '@session-chat/components/engine/block-frame';
import { cancelIdle, scheduleIdle } from '@session-chat/components/engine/dom-utils';
import type { MermaidLaidOut } from '@session-chat/core/layout/layout-types';
import type { MermaidBlock } from '@session-chat/core/markdown/document';
import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { readMermaidTheme, subscribeMermaidTheme } from '@session-chat/core/mermaid/render';
import { mermaidCanvas, mermaidError, mermaidPlaceholder, mermaidWrapper } from './mermaid.css';
import { useChatTranslator } from '@session-chat/localization';

export type MermaidProps = {
  block: MermaidLaidOut;
  rawBlock: MermaidBlock;
};

export function Mermaid(props: MermaidProps) {
  const caches = useCaches();
  const commands = useCommands();
  const translate = useChatTranslator();
  const [svg, setSvg] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);

  const [theme, setTheme] = createSignal(readMermaidTheme());
  onCleanup(subscribeMermaidTheme(() => setTheme(readMermaidTheme())));

  createEffect(() => {
    const source = props.rawBlock.source;
    const t = theme();

    // Synchronous fast-path when SVG is already cached (e.g. scroll-back).
    const cached = caches.peekMermaid(source, t);
    if (cached) {
      setSvg(cached);
      setFailed(false);
      return;
    }

    // Deferred path — render on idle to keep first-paint / scroll off the
    // critical path. The previous diagram stays up until its replacement
    // arrives, so a theme switch swaps pictures without flashing the placeholder.
    const abort = new AbortController();
    const handle = scheduleIdle(() => {
      void caches.renderMermaid(source, t, abort.signal).then((result) => {
        if (abort.signal.aborted) return;
        setSvg(result);
        // Source mermaid rejects — show error fallback.
        setFailed(result === null);
      });
    });

    onCleanup(() => {
      abort.abort();
      cancelIdle(handle);
    });
  });

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    commands().onViewMermaid?.({
      chart: props.rawBlock.source,
      blockId: props.block.id,
      source: 'mermaid-block',
    });
  }

  return (
    <BlockFrame layout={props.block}>
      <div
        class={mermaidWrapper}
        role="button"
        aria-label={translate('transcript.viewMermaid')}
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') handleClick(e as unknown as MouseEvent);
        }}
      >
        <Show
          when={svg()}
          fallback={
            <Show
              when={failed()}
              fallback={<span class={mermaidPlaceholder}>{translate('transcript.mermaidDiagram')}</span>}
            >
              <span class={mermaidError}>{translate('transcript.mermaidError')}</span>
            </Show>
          }
        >
          {(s) => <div class={mermaidCanvas} innerHTML={s()} />}
        </Show>
      </div>
    </BlockFrame>
  );
}

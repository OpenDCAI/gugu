/** @jsxImportSource solid-js */
/**
 * Execute — SolidJS components for ChatExecute rows.
 *
 * Renders ACP `kind: 'execute'` tool calls as a header line above a body:
 *
 *   Run the build ›                        ← header (CollapseHeader primitive)
 *   $ pnpm run build --filter=...          ← body: mono, bash-highlighted,
 *     ...                                    clamped to collapsedMaxLines or
 *                                            expandedMaxLines with overflow scroll
 *
 * Header is the shared CollapseHeader that thinking / plan / file-op use.
 * Body:   collapsed = clamped height + fade overlay; expanded = scrollable.
 */

import { useCaches } from '@session-chat/components/contexts/CachesContext';
import { cancelIdle, scheduleIdle } from '@session-chat/components/engine/dom-utils';
import { applyTokensToElement, type CodeToken } from '@session-chat/core/highlight/apply-tokens';
import { For, Show, createEffect, onCleanup } from 'solid-js';
import { executeBody, executeLine, executeOutputLine, executeSpacerLine } from './execute.css';
import { fadeOverlayBottom } from '@session-chat/styles/effects.css';
import { applySoftWraps } from '@session-chat/core/measure/soft-wrap';
import { type ExecuteDisplayLine } from './execute.layout';

// ── ExecuteBody ───────────────────────────────────────────────────────────────

export type ExecuteBodyProps = {
  lines: ExecuteDisplayLine[];
  bodyH: number;
  contentH: number;
  codeLineH: number;
  expanded: boolean;
};

export function applyTokensWithSoftWraps(
  el: HTMLElement,
  tokens: CodeToken[],
  softWrapOffsets: number[],
): void {
  if (softWrapOffsets.length === 0) {
    applyTokensToElement(el, tokens);
    return;
  }

  const wrappedTokens: CodeToken[] = [];
  let sourceOffset = 0;
  let breakIndex = 0;

  for (const token of tokens) {
    const tokenEnd = sourceOffset + token.content.length;
    let tokenOffset = 0;

    while (breakIndex < softWrapOffsets.length && softWrapOffsets[breakIndex] <= tokenEnd) {
      const localBreak = Math.max(0, softWrapOffsets[breakIndex] - sourceOffset);
      if (localBreak > tokenOffset) {
        wrappedTokens.push({ ...token, content: token.content.slice(tokenOffset, localBreak) });
      }
      wrappedTokens.push({ content: '\n' });
      tokenOffset = localBreak;
      breakIndex++;
    }

    if (tokenOffset < token.content.length) {
      wrappedTokens.push({ ...token, content: token.content.slice(tokenOffset) });
    }
    sourceOffset = tokenEnd;
  }

  applyTokensToElement(el, wrappedTokens);
}

export function ExecuteBody(props: ExecuteBodyProps) {
  const caches = useCaches();
  const lineEls = new Map<number, HTMLElement>();

  createEffect(() => {
    const commandLines = props.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.kind === 'command');
    const command = commandLines.map(({ line }) => line.text).join('\n');
    if (!command || !lineEls.size) return;

    function paint(tokenLines: CodeToken[][]): void {
      for (let i = 0; i < commandLines.length; i++) {
        const el = lineEls.get(commandLines[i].index);
        const tokens = tokenLines[i];
        if (el && tokens) {
          applyTokensWithSoftWraps(el, tokens, commandLines[i].line.softWrapOffsets);
        }
      }
    }

    const cached = caches.peekHighlight(command, 'bash');
    if (cached) {
      paint(cached.lines);
      return;
    }

    let cancelled = false;
    const handle = scheduleIdle(() => {
      if (cancelled) return;
      const result = caches.highlight(command, 'bash');
      if (cancelled || !result) return;
      paint(result.lines);
    });

    onCleanup(() => {
      cancelled = true;
      cancelIdle(handle);
    });
  });

  const overflows = () => props.contentH > props.bodyH;

  return (
    <div
      class={executeBody}
      style={{
        height: `${props.bodyH}px`,
        'overflow-x': 'auto',
        'overflow-y': props.expanded ? 'auto' : 'hidden',
      }}
    >
      <Show when={!props.expanded && overflows()}>
        <div
          class={fadeOverlayBottom}
          style={{
            position: 'absolute',
            inset: '0',
            'pointer-events': 'none',
            height: '28px',
            bottom: '0',
            top: 'auto',
          }}
          aria-hidden="true"
        />
      </Show>
      <For each={props.lines}>
        {(line, i) => (
          <div
            ref={(el) => {
              lineEls.set(i(), el);
              onCleanup(() => lineEls.delete(i()));
            }}
            class={executeLine}
            classList={{
              [executeOutputLine]: line.kind === 'output',
              [executeSpacerLine]: line.kind === 'spacer',
            }}
            style={{
              height: `${line.visualLineCount * props.codeLineH}px`,
              'line-height': `${props.codeLineH}px`,
            }}
          >
            {applySoftWraps(line.text, line.softWrapOffsets)}
          </div>
        )}
      </For>
    </div>
  );
}

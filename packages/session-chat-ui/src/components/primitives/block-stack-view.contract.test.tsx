/** @jsxImportSource solid-js */
/**
 * Chromium contract for F47 — a streaming chunk remounts only the block it changed.
 *
 * Every row of a streaming message or thought is a BlockStackView. When each chunk
 * remounted every block (innerHTML, mention icons, code colouring, fade walk), a long
 * generation did O(message) DOM work per chunk and the renderer went from 12 ms to
 * over a minute per round-trip.
 */
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { createChatCaches } from '@session-chat/core/caches';
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config';
import type { MeasureCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { BlockStackView } from './BlockStackView';

describe('BlockStackView streaming (F47)', () => {
  it('keeps a settled block mounted while the growing block below it remounts', () => {
    const theme = buildChatTheme(DEFAULT_CONFIG, { preset: 'single', userGutter: 0 });
    const caches = createChatCaches();
    const ctx: MeasureCtx = {
      theme,
      width: 640,
      isCollapsed: () => false,
      expanded: () => false,
      caches,
      expandedId: null,
    };
    const layoutOf = (text: string) => layoutBlockStack(caches.parseBlocksStreaming('s', text), ctx);
    const [node, setNode] = createSignal(layoutOf('settled paragraph\n\ngrowing'));

    const host = document.createElement('div');
    host.style.width = '640px';
    document.body.appendChild(host);
    const dispose = render(
      () => (
        <ThemeContext.Provider value={() => theme}>
          <CachesContext.Provider value={caches}>
            <CommandsContext.Provider value={() => ({})}>
              <BlockStackView node={node()} />
            </CommandsContext.Provider>
          </CachesContext.Provider>
        </ThemeContext.Provider>
      ),
      host
    );

    try {
      const [settled] = host.querySelectorAll('.gg-md');
      setNode(layoutOf('settled paragraph\n\ngrowing tail'));
      const blocks = host.querySelectorAll('.gg-md');
      expect(blocks[0]).toBe(settled);
      expect(blocks[1]?.textContent).toBe('growing tail');
    } finally {
      dispose();
      host.remove();
    }
  });
});

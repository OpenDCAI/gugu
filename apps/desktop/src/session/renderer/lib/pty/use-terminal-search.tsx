import type { Terminal } from '@xterm/xterm';
import { useMemo, useRef } from 'react';
import type { FindBackend, FindStatus } from '@renderer/lib/ui/use-find-bar';
import {
  collectTerminalSearchMatches,
  getNextTerminalSearchIndex,
  type TerminalSearchBufferLike,
  type TerminalSearchMatch,
} from './terminal-search';

const EMPTY_SEARCH_STATUS: FindStatus = { currentIndex: 0, total: 0 };

/** Find in the terminal's buffer: the match becomes the terminal selection and is scrolled to mid-screen. */
export function useTerminalFindBackend(terminal: Terminal | null | undefined, enabled: boolean): FindBackend | null {
  // The last search, possibly on a terminal that has since been replaced (its selection is cleared first).
  const searchedRef = useRef<{ terminal: Terminal; query: string; match: TerminalSearchMatch | null } | null>(null);

  return useMemo<FindBackend | null>(() => {
    const clear = () => {
      const searched = searchedRef.current;
      searchedRef.current = null;
      try {
        searched?.terminal.clearSelection();
      } catch {}
    };
    if (!enabled || !terminal) return null;

    const run = (query: string, direction: 'next' | 'prev', reset: boolean): FindStatus => {
      const previous = searchedRef.current;
      if (previous && previous.terminal !== terminal) clear();
      if (!query) {
        clear();
        return EMPTY_SEARCH_STATUS;
      }
      const buffer = terminal.buffer?.active as TerminalSearchBufferLike | undefined;
      const matches = buffer ? collectTerminalSearchMatches(buffer, query) : [];
      const currentMatch = !reset && previous?.terminal === terminal && previous.query === query ? previous.match : null;
      if (matches.length === 0) {
        searchedRef.current = { terminal, query, match: null };
        if (buffer) {
          try {
            terminal.clearSelection();
          } catch {}
        }
        return EMPTY_SEARCH_STATUS;
      }
      const matchIndex = getNextTerminalSearchIndex(matches, currentMatch, direction);
      const match = matches[matchIndex];
      searchedRef.current = { terminal, query, match };
      try {
        terminal.select(match.col, match.row, match.length);
        const contextRows = Math.max(0, Math.floor(terminal.rows / 2));
        terminal.scrollToLine(Math.max(0, match.row - contextRows));
      } catch {}
      return { currentIndex: matchIndex + 1, total: matches.length };
    };

    return {
      find: (query) => run(query, 'next', true),
      step: (direction) => run(searchedRef.current?.query ?? '', direction, false),
      clear,
    };
  }, [enabled, terminal]);
}

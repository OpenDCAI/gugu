import { isMacHost } from '@shared/host-os';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export type FindStatus = { currentIndex: number; total: number };

/** What a find bar searches: `find` starts over from the first match, `step` moves from the current one. */
export type FindBackend = {
  find(query: string): FindStatus;
  step(direction: 'next' | 'prev'): FindStatus;
  clear(): void;
};

const EMPTY: FindStatus = { currentIndex: 0, total: 0 };
const IS_MAC = isMacHost();

/**
 * ⌘F / Ctrl+F with focus inside `rootRef` opens the bar (or refocuses it); closing returns focus to where it was.
 * A new backend takes over the open query; no backend closes the bar. `debounceMs` 0 searches on every keystroke.
 */
export function useFindBar({
  rootRef,
  backend,
  debounceMs = 0,
}: {
  rootRef: RefObject<HTMLElement | null>;
  backend: FindBackend | null;
  debounceMs?: number;
}) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pending = useRef<{ timer: number; query: string } | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setQuery] = useState('');
  const [searchStatus, setStatus] = useState<FindStatus>(EMPTY);
  const latest = useRef({ isOpen, searchQuery });
  latest.current = { isOpen, searchQuery };

  const focusInput = () => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  };

  const takePending = useCallback(() => {
    const queued = pending.current;
    if (queued) window.clearTimeout(queued.timer);
    pending.current = null;
    return queued?.query ?? null;
  }, []);

  const reset = useCallback(() => {
    takePending();
    setQuery('');
    setStatus(EMPTY);
    setIsOpen(false);
  }, [takePending]);

  const onClose = useCallback(() => {
    backend?.clear();
    reset();
    if (returnFocus.current?.isConnected) returnFocus.current.focus();
    returnFocus.current = null;
  }, [backend, reset]);

  const onQueryChange = useCallback(
    (next: string) => {
      setQuery(next);
      takePending();
      if (!backend) return;
      if (!debounceMs || !next) {
        setStatus(backend.find(next));
        return;
      }
      const timer = window.setTimeout(() => {
        pending.current = null;
        setStatus(backend.find(next));
      }, debounceMs);
      pending.current = { timer, query: next };
    },
    [backend, debounceMs, takePending]
  );

  // Enter right after typing runs the queued search instead of stepping past it.
  const onStep = useCallback(
    (direction: 'next' | 'prev') => {
      if (!backend || !searchQuery) return;
      const queued = takePending();
      setStatus(queued !== null ? backend.find(queued) : backend.step(direction));
    },
    [backend, searchQuery, takePending]
  );

  useEffect(() => {
    const { isOpen: open, searchQuery: query } = latest.current;
    const id = requestAnimationFrame(() => {
      if (!backend) reset();
      else if (open && query) setStatus(backend.find(query));
    });
    return () => {
      cancelAnimationFrame(id);
      backend?.clear();
    };
  }, [backend, reset]);

  // Focus in the commit that mounts the bar, so the very next keystroke after ⌘F already lands in it.
  useLayoutEffect(() => {
    if (isOpen) focusInput();
  }, [isOpen]);

  useEffect(() => {
    if (!backend) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const active = document.activeElement;
      if (!mod || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') return;
      if (!(active instanceof HTMLElement) || !rootRef.current?.contains(active)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (latest.current.isOpen) return focusInput();
      returnFocus.current = active;
      setIsOpen(true);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [backend, rootRef]);

  return { isOpen, searchQuery, searchStatus, searchInputRef, onQueryChange, onStep, onClose };
}

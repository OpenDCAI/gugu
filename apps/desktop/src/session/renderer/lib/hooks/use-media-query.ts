import { useSyncExternalStore } from 'react';

/**
 * Subscribe to a CSS media query. SSR/tests without `matchMedia` read as `false`.
 * useSyncExternalStore keeps the read tear-free and re-renders only on change.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {};
      }
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : false,
    () => false
  );
}

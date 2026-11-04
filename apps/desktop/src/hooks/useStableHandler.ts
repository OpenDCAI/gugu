import { useCallback, useLayoutEffect, useRef } from 'react'

/** A handler whose identity never changes but always calls the latest closure — for props of memoized retained
 *  surfaces, where a fresh function each parent render would re-render the whole hidden tree. */
export function useStableHandler<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
  const latest = useRef(handler)
  useLayoutEffect(() => { latest.current = handler })
  return useCallback((...args: A) => latest.current(...args), [])
}

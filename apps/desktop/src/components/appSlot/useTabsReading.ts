import { comparer, reaction } from 'mobx'
import { useEffect, useRef, useState, type DependencyList } from 'react'

/** A reading of the chats' tab engine (MobX) for a component that is not an observer: re-rendered when it changes. */
export function useTabsReading<T>(read: () => T, deps: DependencyList): T {
  const latest = useRef(read)
  latest.current = read
  const [value, setValue] = useState(read)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` name what `read` reads
  useEffect(() => reaction(() => latest.current(), setValue, { fireImmediately: true, equals: comparer.structural }), deps)
  return value
}

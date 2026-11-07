/** Published objects are immutable; a changed dependency invalidates their derived value. */
export function memoizeByReference<K extends object, C, T>(derive: (key: K, context: C) => T) {
  const values = new WeakMap<K, { context: C; value: T }>()
  return (key: K, context: C): T => {
    const held = values.get(key)
    if (held && held.context === context) return held.value
    const value = derive(key, context)
    values.set(key, { context, value })
    return value
  }
}

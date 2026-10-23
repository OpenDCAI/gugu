/** Serialize the Android renderer's auth work with transfer of refresh ownership to Node. */
export function createPhoneHostAuthGate() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work)
    tail = result.catch(() => undefined)
    return result
  }
}

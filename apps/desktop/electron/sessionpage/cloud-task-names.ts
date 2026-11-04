/** Share the boot, auth-change and owned-agent refresh flight; a burst needs one trailing adoption. */
export function createCloudTaskNameAdopter({ adopt, failed }: {
  adopt: () => Promise<void>
  failed: (error: unknown) => void
}): () => Promise<void> {
  let flight: { again: boolean; promise: Promise<void> } | null = null
  return function refresh(): Promise<void> {
    if (flight) {
      flight.again = true
      return flight.promise
    }
    const state = { again: false, promise: null as unknown as Promise<void> }
    flight = state
    state.promise = (async () => {
      do {
        state.again = false
        try { await adopt() } catch (error) { failed(error) }
      } while (state.again)
    })().finally(() => { flight = null })
    return state.promise
  }
}

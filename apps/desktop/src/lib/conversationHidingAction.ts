/** The hide receipt is final. Agent deletion and retries never hide the conversation again. */
export async function runConversationHidingAction({ hide, removeAgent, removalFailed, isCurrent = () => true }: {
  hide: () => Promise<void>
  removeAgent?: () => Promise<void>
  removalFailed: (error: unknown, retry: () => Promise<void>) => void
  isCurrent?: () => boolean
}): Promise<void> {
  await hide()
  if (!removeAgent || !isCurrent()) return
  let inFlight: Promise<void> | undefined
  const retry = (): Promise<void> => {
    if (!isCurrent()) return Promise.resolve()
    if (inFlight) return inFlight
    inFlight = removeAgent().catch((error: unknown) => {
      if (isCurrent()) removalFailed(error, retry)
    }).finally(() => { inFlight = undefined })
    return inFlight
  }
  await retry()
}

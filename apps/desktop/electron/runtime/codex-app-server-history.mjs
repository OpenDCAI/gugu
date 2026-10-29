/** A resumed thread can exist even when its history could not be established. */
export async function replayHistoryWithinBudget(deadline, replay, now = Date.now) {
  if (now() >= deadline) return { status: 'unknown', reason: 'session/load history budget exhausted' }
  try {
    const incomplete = await replay()
    return incomplete ? { status: 'unknown', reason: incomplete } : { status: 'known' }
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** This is not an ordinary failed resume: the original thread is already established. */
export function historyUnknownError(sessionId, reason) {
  return {
    code: -32015,
    message: `History unknown: ${reason}`,
    data: { kind: 'history_unknown', sessionId, reason },
  }
}

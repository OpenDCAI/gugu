/**
 * Whether a v2 `session/resume` asks for history replay (#980).
 *
 * ACP v2: an omitted or `null` `replayFrom` means resume without replay, `{ type: 'start' }` means replay
 * everything retained, and any other cursor must be refused with -32602 rather than replaced by another.
 * The host's older `_meta.history.replay === false` switch still turns a requested replay off.
 */
export function resumeReplayRequest(params) {
  const replayFrom = params?.replayFrom ?? null
  if (replayFrom === null) return { replay: false }
  if (replayFrom.type !== 'start') {
    return {
      error: { code: -32602, message: `Replaying from a ${String(replayFrom.type)} cursor is not supported` },
    }
  }
  return { replay: params?._meta?.history?.replay !== false }
}

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

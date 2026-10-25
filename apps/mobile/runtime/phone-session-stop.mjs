/** A cancellation acknowledgement is not a final executor state. */
export async function stopPhoneSession({ cancel, running, snapshot, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 10_000 }) {
  const result = await cancel()
  const until = now() + timeoutMs
  while (running()) {
    if (now() >= until) throw Object.assign(new Error('Cancellation requested; this executor is still stopping. Check session_get before reporting it stopped.'), { code: 'stop_pending' })
    await sleep(20)
  }
  return { ...snapshot(), ...result, settled: true }
}

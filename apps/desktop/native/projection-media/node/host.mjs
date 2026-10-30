import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'

const MAX_JSON = 129 * 1024
const MAX_CONTROL = 16 * 1024

/** Decode only bounded helper events. Binary frames are host → helper only. */
export async function* mediaMessages(input) {
  let pending = Buffer.alloc(0)
  for await (const chunk of input) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk)
    while (pending.length >= 4) {
      const size = pending.readUInt32BE(0)
      if (size < 2 || size > MAX_JSON + 1) throw new Error('Invalid media event size')
      if (pending.length >= 5 && pending[4] !== 1) throw new Error('Invalid media event kind')
      if (pending.length < size + 4) break
      const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(5, size + 4)))
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid media event')
      pending = pending.subarray(size + 4)
      yield event
    }
  }
  if (pending.length) throw new Error('Truncated media event')
}

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  // Startup or process exit may precede the consumer's next await.
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
const errorOf = value => value instanceof Error ? value : new Error(String(value))

/** Trusted host primitive. It creates no App/task authorization and opens no cloud channel. */
export async function openMediaProcess(options) {
  const { executable, ffmpeg, width, height, fps, bitrate, signal } = options
  if (!isAbsolute(executable) || !isAbsolute(ffmpeg)) throw new Error('Media executables must be host-resolved absolute paths')
  if (![width, height, fps, bitrate].every(Number.isSafeInteger) || width < 2 || height < 2 || width > 2560 || height > 2560
    || width % 2 || height % 2 || fps < 1 || fps > 60 || bitrate < 64000 || bitrate > 14000000) throw new Error('Invalid media configuration')
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16)
  if (blocks > 3600 || blocks * fps > 108000) throw new Error('Media configuration exceeds H264 level 3.1')
  if (options.stun !== undefined && (typeof options.stun !== 'string' || options.stun.length > 512
    || !/^stuns?:/.test(options.stun))) throw new Error('Only host-configured STUN discovery is allowed')
  signal?.throwIfAborted()
  const args = ['-ffmpeg', ffmpeg, '-width', String(width), '-height', String(height), '-fps', String(fps), '-bitrate', String(bitrate)]
  if (options.stun) args.push('-stun', options.stun)
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const offer = deferred()
  const exited = deferred()
  const waiting = new Map()
  let nextId = 0
  let writing = Promise.resolve()
  let frame = null
  let lastFrame = 0
  let offered = false
  let answering = false
  let ready = false
  let closing = null
  let failure = null
  let closedReceipt = false
  let diagnostics = Buffer.alloc(0)
  let earlyControls = []
  let earlyBytes = 0
  let stopTimer
  let physicalExit = false
  const stop = reason => {
    if (failure) return
    failure = errorOf(reason)
    ready = false
    offer.reject(failure)
    for (const request of waiting.values()) request.reject(failure)
    waiting.clear()
    frame?.reject(failure)
    frame = null
    if (!physicalExit) {
      // Closing the owning pipe also interrupts a blocking read on fd 0. A
      // signal alone need not wake an inherited blocking stdin on every OS.
      child.stdin.destroy()
      // This exact child was spawned above; no machine-wide process matching.
      child.kill('SIGTERM')
      stopTimer = setTimeout(() => { if (!physicalExit) child.kill('SIGKILL') }, 2000)
      stopTimer.unref()
    }
  }
  const abort = () => stop(signal.reason ?? new Error('Media process cancelled'))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  child.stderr.on('data', data => { diagnostics = Buffer.concat([diagnostics, data]).subarray(-4096) })
  child.on('error', stop)
  child.stdin.on('error', stop)
  const startup = setTimeout(() => stop(new Error('Media offer timed out')), 10000)
  const accept = event => {
    if (failure) return
    if (event.type === 'error') throw new Error(`Media helper failed: ${String(event.error).slice(0, 4096)}`)
    if (event.type === 'offer') {
      if (offered || event.sdp?.type !== 'offer' || typeof event.sdp.sdp !== 'string' || event.sdp.sdp.length > 128 * 1024) throw new Error('Invalid media offer')
      offered = true
      clearTimeout(startup)
      offer.resolve(Object.freeze({ ...event.sdp }))
      return
    }
    if (event.type === 'control') {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_CONTROL || !answering) throw new Error('Invalid media control event')
      if (closing) return
      if (!ready) {
        earlyBytes += Buffer.byteLength(event.data)
        if (earlyControls.length >= 64 || earlyBytes > 256 * 1024) throw new Error('Early media control queue is full')
        earlyControls.push(event.data)
        return
      }
      // Delivery is synchronous and bounded. The owning host orders input execution.
      options.onControl?.(event.data)
      return
    }
    if (event.type === 'encoded') {
      const receipt = event.frame
      if (!frame || receipt?.sequence !== frame.sequence || receipt.width !== width || receipt.height !== height
        || !Number.isInteger(receipt.rtpTimestamp) || receipt.rtpTimestamp < 0 || receipt.rtpTimestamp > 0xffffffff) throw new Error('Unassociated encoded media frame')
      const done = frame
      frame = null
      done.resolve(Object.freeze({ ...receipt }))
      return
    }
    const request = waiting.get(event.id)
    if (!request || request.expected !== event.type) throw new Error('Unassociated media command receipt')
    waiting.delete(event.id)
    if (event.type === 'ready') {
      ready = true
      const controls = earlyControls
      earlyControls = []
      earlyBytes = 0
      if (!closing) for (const data of controls) options.onControl?.(data)
    }
    if (event.type === 'closed') { ready = false; closedReceipt = true }
    request.resolve()
  }
  const reading = (async () => {
    try { for await (const event of mediaMessages(child.stdout)) accept(event) }
    catch (error) { stop(error) }
  })()
  child.once('close', (code, terminationSignal) => {
    physicalExit = true
    clearTimeout(startup)
    clearTimeout(stopTimer)
    signal?.removeEventListener('abort', abort)
    void reading.then(() => {
      if (terminationSignal === 'SIGKILL') failure = new Error(`Media cleanup required SIGKILL: ${failure?.message ?? 'unknown failure'}`)
      if (!failure && (code !== 0 || !closedReceipt)) stop(new Error(`Media helper exited without a clean close (${code ?? terminationSignal}): ${diagnostics.toString()}`))
      if (failure) exited.reject(failure)
      else exited.resolve()
    })
  })
  const write = (kind, payload) => {
    if (failure || physicalExit) return Promise.reject(failure ?? new Error('Media helper exited'))
    const pieces = Array.isArray(payload) ? payload : [payload]
    const header = Buffer.alloc(5)
    header.writeUInt32BE(pieces.reduce((size, piece) => size + piece.byteLength, 1), 0)
    header[4] = kind
    const next = writing.then(() => new Promise((resolve, reject) => {
      if (failure || physicalExit) { reject(failure ?? new Error('Media helper exited')); return }
      const chunks = [header, ...pieces]
      let remaining = chunks.length, failed
      const complete = error => {
        failed ??= error
        if (--remaining === 0) { if (failed) reject(failed); else resolve() }
      }
      // One ordered writev batch borrows the pixel view until all callbacks
      // finish. Neither a large payload buffer nor a concatenated copy is made.
      child.stdin.cork()
      try { for (const chunk of chunks) child.stdin.write(chunk, complete) }
      catch (error) { reject(error) }
      finally { child.stdin.uncork() }
    }))
    writing = next.catch(error => { stop(error) })
    return next
  }
  const request = async (type, expected, fields = {}) => {
    if (failure) throw failure
    if (waiting.size >= 64 || nextId === 0xffffffff) throw new Error('Too many media commands')
    const id = ++nextId
    const result = deferred()
    waiting.set(id, { ...result, expected })
    const data = Buffer.from(JSON.stringify({ type, id, ...fields }))
    if (data.length > MAX_JSON) { waiting.delete(id); throw new Error('Media command is too large') }
    const timer = setTimeout(() => stop(new Error(`Media ${type} receipt timed out`)), 15000)
    try { await write(1, data); await result.promise }
    finally { clearTimeout(timer); waiting.delete(id) }
  }
  try {
    const description = await offer.promise
    if (failure) throw failure
    return Object.freeze({
      offer: description,
      closed: exited.promise,
      async answer(sdp) {
        if (answering || closing || failure) throw failure ?? new Error('Media answer is no longer accepted')
        if (sdp?.type !== 'answer' || typeof sdp.sdp !== 'string' || sdp.sdp.length > 128 * 1024) throw new Error('Invalid media answer')
        answering = true
        await request('answer', 'ready', { sdp })
      },
      async publish(sequence, bgra) {
        if (!ready || closing || failure) throw failure ?? new Error('Media is not connected')
        if (!Number.isSafeInteger(sequence) || sequence <= lastFrame || !(bgra instanceof Uint8Array)
          || bgra.byteLength !== width * height * 4) throw new Error('Invalid source media frame')
        if (frame) throw new Error('Media frame is already in flight')
        const result = deferred()
        frame = { ...result, sequence }
        lastFrame = sequence
        const sequenceBytes = Buffer.alloc(8)
        sequenceBytes.writeBigUInt64BE(BigInt(sequence))
        const pixels = Buffer.from(bgra.buffer, bgra.byteOffset, bgra.byteLength)
        const timer = setTimeout(() => stop(new Error('Media frame encoding timed out')), 10000)
        try { await write(2, [sequenceBytes, pixels]); return await result.promise }
        finally { clearTimeout(timer) }
      },
      async sendControl(data) {
        if (!ready || closing || failure) throw failure ?? new Error('Media is not connected')
        if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_CONTROL) throw new Error('Media control message is too large')
        // Resolves on SCTP admission, never on execution of the described action.
        await request('send', 'sent', { data })
      },
      close() {
        if (closing) return closing
        closing = (async () => {
          let exitTimer
          try {
            if (!failure && !physicalExit) {
              await request('close', 'closed')
              if (!physicalExit) exitTimer = setTimeout(() => stop(new Error('Media helper did not exit within 2000 ms after close receipt')), 2000)
            }
          } catch (error) { stop(error) }
          finally { child.stdin.end() }
          try { await exited.promise }
          finally { clearTimeout(exitTimer) }
        })()
        void closing.catch(() => undefined)
        return closing
      },
    })
  } catch (error) {
    stop(error)
    await exited.promise.catch(() => undefined)
    throw error
  }
}

const MAX_CONTROL = 16 * 1024
const MAX_SDP = 128 * 1024
const positive = value => Number.isSafeInteger(value) && value > 0

/** Browser media receiver only. The caller owns authenticated signaling and App/task authority. */
export async function openProjectionVideo({ video, offer, answer, onFrame, onControl, prepareControl, signal }) {
  signal?.throwIfAborted()
  if (offer?.type !== 'offer' || typeof offer.sdp !== 'string' || offer.sdp.length > MAX_SDP) throw new Error('Invalid projection offer')
  if (typeof video?.requestVideoFrameCallback !== 'function' || typeof video.cancelVideoFrameCallback !== 'function') throw new Error('Projection video frame callbacks are unavailable')
  const peer = new RTCPeerConnection({ iceServers: [] }) // viewer also configures no TURN
  const receipts = new Map()
  const tracks = new Set()
  const signing = new AbortController()
  let controls = Promise.resolve(), queued = 0
  let channel, visible, callback, lastSequence = 0, lastPainted = 0, lastPaintedStamp, lastReceipt, closing = false
  let resolveReady, rejectReady, resolveClosed, rejectClosed, failure
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  void ready.catch(() => undefined)
  void closed.catch(() => undefined)
  const close = error => {
    if (closing) return
    closing = true
    failure = error
    signing.abort(error ?? new Error('Projection viewer closed'))
    clearTimeout(deadline)
    signal?.removeEventListener('abort', abort)
    if (callback !== undefined) video.cancelVideoFrameCallback(callback)
    receipts.clear()
    channel?.close()
    peer.close()
    for (const track of tracks) track.stop()
    video.srcObject = null
    try { onFrame?.(null, sendControl) } catch { /* Cleanup must still settle if a consumer failed. */ }
    rejectReady(error ?? new Error('Projection viewer closed'))
    if (error) rejectClosed(error); else resolveClosed()
  }
  const abort = () => close(signal.reason ?? new Error('Projection viewer cancelled'))
  const deadline = setTimeout(() => close(new Error('Projection media handshake timed out')), 15000)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const check = () => { if (closing) throw failure ?? new Error('Projection viewer closed') }
  function sendControl(data) {
    check()
    if (typeof data !== 'string' || new TextEncoder().encode(data).length > MAX_CONTROL) throw new Error('Invalid projection control message')
    if (channel?.readyState !== 'open' || channel.bufferedAmount > 256 * 1024) throw new Error('Projection input channel is not writable')
    if (!prepareControl) { channel.send(data); return } // SCTP admission, never an execution acknowledgement
    if (queued >= 64) throw new Error('Projection signing queue is full')
    queued++
    const work = controls.then(async () => {
      check()
      const signed = await Promise.race([Promise.resolve().then(() => prepareControl(data, signing.signal)), stopped])
      check()
      if (typeof signed !== 'string' || new TextEncoder().encode(signed).length > MAX_CONTROL) throw new Error('Invalid signed projection control')
      if (channel?.readyState !== 'open' || channel.bufferedAmount > 256 * 1024) throw new Error('Projection input channel is not writable')
      channel.send(signed)
    }).finally(() => { queued-- })
    controls = work.catch(error => { close(error) })
    return work
  }
  const matched = () => {
    if (!visible || closing) return
    const frame = receipts.get(visible.rtpTimestamp)
    if (!frame || frame.sequence < lastPainted || (frame.sequence === lastPainted && frame.rtpTimestamp === lastPaintedStamp)) return
    if (frame.width !== visible.width || frame.height !== visible.height) throw new Error('Projection decoded geometry does not match its receipt')
    lastPainted = frame.sequence
    lastPaintedStamp = frame.rtpTimestamp
    receipts.delete(frame.rtpTimestamp)
    onFrame?.(frame, sendControl)
  }
  const guard = fn => event => { if (!closing) try { fn(event) } catch (error) { close(error) } }
  // A receipt arriving later may acknowledge only the frame still visible now.
  // Retaining older decoded frames would permit input against a replaced picture.
  const observe = (now, metadata) => {
    if (closing) return
    try {
      if (!Number.isInteger(metadata.rtpTimestamp) || metadata.rtpTimestamp < 0 || metadata.rtpTimestamp > 0xffffffff
        || !positive(metadata.width) || !positive(metadata.height)) throw new Error('Projection decoder omitted frame correlation metadata')
      visible = { rtpTimestamp: metadata.rtpTimestamp, width: metadata.width, height: metadata.height }
      onFrame?.(null, sendControl)
      matched()
      callback = video.requestVideoFrameCallback(observe)
    } catch (error) { close(error) }
  }
  callback = video.requestVideoFrameCallback(observe)
  peer.ontrack = guard(event => {
    if (event.track.kind !== 'video' || tracks.size) throw new Error('Unexpected projection media track')
    tracks.add(event.track)
    event.track.onended = () => close(new Error('Projection video track ended'))
    video.srcObject = new MediaStream([event.track])
    void video.play().catch(error => close(error))
  })
  peer.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) close(new Error('Projection media connection closed'))
  }
  peer.ondatachannel = guard(event => {
    const incoming = event.channel
    if (channel || incoming.label !== 'gugu-projection-input' || !incoming.ordered
      || incoming.maxRetransmits !== null || incoming.maxPacketLifeTime !== null) {
      incoming.close()
      throw new Error('Unexpected projection input channel')
    }
    channel = incoming
    incoming.onopen = () => resolveReady()
    incoming.onclose = () => close(new Error('Projection input channel closed'))
    incoming.onerror = () => close(new Error('Projection input channel failed'))
    incoming.onmessage = guard(event => {
      if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > MAX_CONTROL) throw new Error('Invalid projection control message')
      let value
      try { value = JSON.parse(event.data) } catch { /* App control bytes need not be JSON. */ }
      if (value?.type !== 'frame') { onControl?.(event.data, sendControl); return }
      const frame = value.frame
      const repeat = frame?.recovery === true && frame.sequence === lastSequence
      const delta = lastReceipt && ((frame?.rtpTimestamp - lastReceipt.rtpTimestamp) >>> 0)
      if (!positive(frame?.sequence) || frame.sequence < lastSequence || (frame.sequence === lastSequence && !repeat)
        || (repeat && (!delta || delta >= 0x80000000 || frame.width !== lastReceipt.width || frame.height !== lastReceipt.height))
        || !positive(frame.width) || !positive(frame.height)
        || frame.width > 2560 || frame.height > 2560 || !Number.isInteger(frame.rtpTimestamp)
        || frame.rtpTimestamp < 0 || frame.rtpTimestamp > 0xffffffff) throw new Error('Invalid projection frame receipt')
      lastSequence = frame.sequence
      lastReceipt = frame
      // Old timestamps of a recovered source never acknowledge the new paint.
      for (const [stamp, prior] of receipts) if (prior.sequence <= frame.sequence) receipts.delete(stamp)
      receipts.set(frame.rtpTimestamp, Object.freeze({ sequence: frame.sequence, rtpTimestamp: frame.rtpTimestamp, width: frame.width, height: frame.height,
        ...(repeat ? { recovery: true } : {}) }))
      if (receipts.size > 64) receipts.delete(receipts.keys().next().value)
      matched()
    })
    if (incoming.readyState === 'open') resolveReady()
  })
  // Cancellation/deadline also wins over a pending browser API or caller callback.
  const stopped = closed.then(() => { throw new Error('Projection viewer closed') })
  void stopped.catch(() => undefined)
  try {
    await Promise.race([peer.setRemoteDescription(offer), stopped])
    check()
    const gathered = new Promise(resolve => {
      peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === 'complete') resolve() }
    })
    const description = await Promise.race([peer.createAnswer(), stopped])
    check()
    await Promise.race([peer.setLocalDescription(description), stopped])
    check()
    if (peer.iceGatheringState !== 'complete') await Promise.race([gathered, stopped])
    check()
    await Promise.race([answer({ type: 'answer', sdp: peer.localDescription.sdp }), stopped])
    await ready
    check()
    clearTimeout(deadline)
    return Object.freeze({
      closed,
      sendControl,
      close: () => close(),
    })
  } catch (error) { close(error); throw error }
}

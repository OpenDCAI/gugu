/** The stdin entry owns every turn and host started through this process. */
export function createAgentEntry({ runTurn, cancelTurn, startPhoneAgentHost, bridge, output }) {
  let closed = false
  let closePromise
  let host
  let hostStartPromise
  let hostClosePromise
  let legacySessionId
  let legacyTask
  let ownerId
  const emit = (event) => { if (!closed) output(event) }
  const requireOpen = () => { if (closed) throw new Error('手机运行时输入已关闭') }
  const startTurn = (...args) => { requireOpen(); return runTurn(...args) }
  const nativeCall = (...args) => { requireOpen(); return bridge.call(...args) }
  const closeHost = (started) => hostClosePromise ??= Promise.resolve().then(() => started.close())

  const run = (command) => {
    requireOpen()
    if (legacySessionId || host || hostStartPromise) throw new Error('手机运行时已在使用中')
    legacySessionId = command.sessionId
    ownerId = command.ownerId
    const task = Promise.resolve().then(() => {
      requireOpen()
      return startTurn(command, { emit, nativeCall })
    }).then((result) => emit({ type: result.status, sessionId: command.sessionId, text: result.text, message: result.error }))
      .finally(() => { legacySessionId = undefined; if (legacyTask === task) legacyTask = undefined })
    legacyTask = task
    return task
  }

  const startHost = async (command) => {
    requireOpen()
    const config = command.config ?? command
    if (legacySessionId) throw new Error('手机运行时正在启动另一项任务')
    if (host) { await host.handle(command); return }
    if (hostStartPromise) {
      const started = await hostStartPromise
      if (!closed) await started.handle(command)
      return
    }
    ownerId = config.ownerId
    const starting = Promise.resolve().then(() => {
      requireOpen()
      return startPhoneAgentHost(config, {
        runTurn: startTurn, cancelTurn,
        emit: (event) => emit({ ...event, ownerId }),
        nativeCall: (name, args, signal, context) => nativeCall(name, args, signal, { ...context, ownerId }),
      })
    })
    hostStartPromise = starting
    try { host = await starting }
    finally { if (hostStartPromise === starting) hostStartPromise = undefined }
  }

  return {
    handleLine(line) {
      if (closed) return
      try {
        const command = JSON.parse(line)
        if (command.type === 'tool_result') { bridge.resolve(command); return }
        if (command.type === 'cancel' && !host) { cancelTurn(command.sessionId ?? legacySessionId); return }
        if (command.type === 'run') { void run(command).catch((error) => emit({ type: 'failed', message: error.message })); return }
        if (command.type === 'host_start' || command.type === 'configure') {
          void startHost(command).catch((error) => emit({ type: 'host_state', ownerId, status: 'failed', ready: false, error: error.message }))
          return
        }
        if (!host) {
          if (command.type === 'host_call') emit({ type: 'host_result', ownerId: ownerId ?? command.ownerId, id: command.id,
            error: { code: 'host_not_ready', message: '手机宿主尚未就绪，请稍后重试' } })
          if (command.type === 'auth_request') emit({ type: 'auth_result', ownerId, id: command.id, error: { message: '手机宿主尚未就绪' } })
          if (command.type === 'host_stop' && hostStartPromise) void hostStartPromise.then(closeHost).catch(() => undefined)
          return
        }
        void Promise.resolve(host.handle(command)).catch((error) => emit({ type: 'host_error', ownerId, message: error.message }))
      } catch (error) { emit({ type: host ? 'host_error' : 'failed', ownerId, message: error.message }) }
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      if (legacySessionId) cancelTurn(legacySessionId)
      bridge.close()
      const hostShutdown = host ? closeHost(host) : hostStartPromise?.then(closeHost, () => undefined)
      closePromise = Promise.all([legacyTask?.catch(() => undefined), hostShutdown]).then(() => undefined)
      return closePromise
    },
  }
}

/** EOF and a broken parent stdout pipe share the same awaited shutdown path. */
export function bindAgentEntry(entry, { input, output, onError, onTimeout, onClosed = () => undefined, shutdownTimeoutMs = 5_000, timers = { setTimeout, clearTimeout } }) {
  let closing
  const close = () => {
    if (!closing) {
      try { closing = Promise.resolve(entry.close()) }
      catch (error) { closing = Promise.reject(error) }
      let timedOut = false
      const timer = timers.setTimeout(() => { timedOut = true; onTimeout({ reason: 'native_parent_channel_closed', timeoutMs: shutdownTimeoutMs }) }, shutdownTimeoutMs)
      // A failed close is still bounded: only successful cleanup disarms forced shutdown.
      void closing.then(() => { timers.clearTimeout(timer); if (!timedOut) onClosed() }, onError)
      input.close?.()
    }
    return closing
  }
  input.on('line', (line) => entry.handleLine(line))
  input.once('close', close)
  output.on('error', (error) => {
    close()
    if (error.code !== 'EPIPE') onError(error)
  })
  return { close }
}

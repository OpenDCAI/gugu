import { createAssistantWorkOutboxPump } from '../../../packages/core/src/cloud/assistantWorkOutbox.ts'
import { createCloudComputerClient } from '../../../packages/core/src/cloud/cloudComputer.ts'

/** The phone consumes the same cloud event queue; it keeps no second durable outbox. */
export function createPhoneAssistantWorkOutbox({ cloud, ownerId, deviceId, instanceId, isReady, requester, receive, controller: controllerOverride, warn = () => {} }) {
  let closed = false
  let controller = controllerOverride ?? null
  let flight = null
  const closing = new AbortController()
  const context = async () => !closed && isReady() ? { ownerId, deviceId, runtimeInstanceId: instanceId } : null
  const prepare = async (target, signal) => {
    if (!controller) {
      const endpoint = await cloud.attachmentEndpoint()
      controller = createCloudComputerClient({ baseUrl: `${cloud.root}/functions/v1/cloud-computer`, accessToken: cloud.token, anonKey: endpoint.anonKey, requestTimeoutMs: 8000 })
    }
    // Device presence may remain online while frozen. Only the control plane identifies this cloud machine.
    let state = await controller.state(signal)
    if (state.deviceId !== target || state.state === 'awake') return
    await controller.wake()
    while (state.state !== 'awake') {
      signal.throwIfAborted()
      await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); resolve() }
        const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason) }
        const timer = setTimeout(done, 250)
        signal.addEventListener('abort', aborted, { once: true })
      })
      state = await controller.state(signal)
      if (state.deviceId !== target) throw Object.assign(new Error('Cloud delivery target changed'), { code: 'CLOUD_TARGET_CHANGED' })
      if (state.state === 'error') throw Object.assign(new Error('Cloud resume failed'), { code: 'CLOUD_WAKE_FAILED' })
    }
  }
  const pump = createAssistantWorkOutboxPump({
    context, rpc: (name, args) => cloud.identity.rpc(name, args), warn,
    deliver: async (event, signal) => {
      const ref = { assistant_id: event.assistant_user_id, work_id: event.work_id, message_id: event.message_id }
      if (!ref.assistant_id) throw Object.assign(new Error('Work assistant is missing'), { code: 'INVALID_OUTBOX_EVENT' })
      if (event.to_device_id === deviceId) return receive(ref)
      await prepare(event.to_device_id, signal)
      const client = requester()
      if (!client || closed || !isReady()) throw Object.assign(new Error('Phone delivery host is not ready'), { code: 'DELIVERY_NOT_READY' })
      const result = await client.call(event.to_device_id, 'assistantWork.deliver', ref, { timeoutMs: 30000, signal })
      if (result.error) throw Object.assign(new Error('Receiver rejected work delivery'), { code: result.error.code === 'unknown_method' ? 'DELIVERY_HOST_OUTDATED' : result.error.code })
      return result.result?.status === 'admitted' && result.result.messageId === event.message_id ? result.result : { status: 'pending' }
    },
  })
  const reconcile = async () => {
    await pump.kick()
    if (!await context()) return
    const {data,error} = await cloud.identity.rpc('assistant_work_abandoned',{p_runtime_instance_id:instanceId,p_limit:100})
    if (error) throw error
    if (!Array.isArray(data?.events)) throw new Error('Invalid abandoned work list')
    const homes = new Set(data.events.map(event => event.kind === 'dispatch' ? event.from_device_id : event.to_device_id))
    const signal = AbortSignal.any([closing.signal,AbortSignal.timeout(45000)])
    for (const home of homes) {
      if (!home || home === deviceId) continue
      await prepare(home,signal)
      if (!await context()) return
      const client = requester()
      if (!client) throw new Error('Delivery channel unavailable')
      const response = await client.call(home,'assistantWork.reconcile',{}, {timeoutMs:5000,signal})
      if (response.error) throw new Error('Work home could not reconcile delivery')
    }
  }
  return { kick() {
    if (closed) return Promise.resolve()
    if (!flight) flight = reconcile().catch(() => warn({code:'WORK_NOTICE_RECONCILIATION_UNAVAILABLE'})).finally(() => {flight = null})
    return flight
  }, close() { closed = true; closing.abort(); pump.stop() } }
}

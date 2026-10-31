import { DeviceRpcChannelError, DeviceRpcTimeoutError } from '@gugu/core/cloud/deviceRpcRequester'
import { appCallAction, overCallLimit } from '../../session/shared/extensions/machine-call'

/**
 * owner 10-16「程序跟着数据」, on the phone: a phone runs no program and keeps no data folder for a session, but an App page in
 * a session on one of the person's computers has those calls (`BRIDGE_VERBS` rows with `machine`) done THERE, as a page on
 * another desktop does (`agentSession.app_call`): that computer's install of the same version does them, and its refusals
 * keep their codes. One call and its answer are 1 MB each at most. The phone has no device id of its own: the id it calls
 * under is one kept for this install, so that computer can tell a call sent again from a new one.
 */
const CALLER_KEY = 'gugu.phone.appCaller'

function callerId(): string {
  try {
    const kept = window.localStorage.getItem(CALLER_KEY)
    if (kept) return kept
    const minted = `phone-${crypto.randomUUID()}`
    window.localStorage.setItem(CALLER_KEY, minted)
    return minted
  } catch {
    // No storage (a private window): a new id per page life still tells calls apart.
    return `phone-${crypto.randomUUID()}`
  }
}

/** The phone's existing App caller identity, shared by program calls and dispatch. */
export function phoneAppCaller(app: { extensionId: string; extensionName: string }) {
  return { kind: 'app' as const, deviceId: callerId(), deviceLabel: 'phone', extensionId: app.extensionId, extensionName: app.extensionName }
}

const refused = (code: string, message: string) => Object.assign(new Error(message), { code })

type PhoneApp = { extensionId: string; extensionName: string; version: string }
type PhoneSession = { id?: string; deviceId: string; deviceLabel: string | null; online?: boolean }

export async function callOnComputer(app: PhoneApp, session: PhoneSession, method: string, args: Record<string, unknown>): Promise<unknown> {
  const action = appCallAction(session.id ?? { deviceId: session.deviceId }, app.version, method, args, crypto.randomUUID())
  const tooLarge = overCallLimit('call', action, action)
  if (tooLarge) throw tooLarge
  const where = session.deviceLabel ?? session.deviceId
  // What the phone already shows of that computer: offline, nothing is sent (the desktop's own check before a call).
  if (session.online === false) throw refused('unavailable', `"${where}" is offline; nothing was sent there`)
  const caller = phoneAppCaller(app)
  // Imported when a call is made: the session page's connections are not this host's to open at load.
  const { appCallOn } = await import('../../mobile/agent-watch/sessionpage-rpc')
  try {
    return await appCallOn(session.deviceId, caller, action)
  } catch (error) {
    if (error instanceof DeviceRpcTimeoutError) throw refused('unavailable', `"${where}" did not answer — the call may or may not have run there`)
    if (error instanceof DeviceRpcChannelError) throw refused('unavailable', `"${where}" could not be reached (${error.message})`)
    const code = (error as { code?: unknown } | null)?.code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'unknown_method' || message.startsWith('No handler registered for ')) throw refused('unavailable', `咕咕 on "${where}" is too old to do this App's call for a phone`)
    // That computer's own refusal says "this machine" of itself: name it, as the desktop does.
    throw refused(typeof code === 'string' ? code : 'failed', `on "${where}": ${message}`)
  }
}

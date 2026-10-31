import { APP_CALL_MAX_BYTES, type AppCallAction } from '@gugu/session-core/session-record/contract'
import { verbFacts } from './bridge-protocol'
import type { ExtensionManifest } from './manifest'
import { HOSTED_PROGRAM_ELSEWHERE, hostsProgram } from './program-place'
import { decodeTypedId } from '@gugu/core/shared/typedId.mjs'

/** The same address the agent's session_spawn device takes. */
export function appDeviceId(device: unknown): string {
  try {
    return decodeTypedId('device', device, 'device')
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'invalid' })
  }
}

/**
 * owner 10-16「程序跟着数据」: a page in a session on another of the person's machines has some of its calls done on THAT
 * machine — the ones whose row says `machine` (its data folder, its program). One rule, read by the asking side (the
 * desktop's bridge, the phone's host) and the answering one alike: the row, except a program gugu hosts itself (Browser
 * Use), which drives the browser on the screen the page is drawn on and so stays there (161 10-17).
 */
export function followsSessionMachine(manifest: Pick<ExtensionManifest, 'contributes'>, method: string, args: Record<string, unknown>): boolean {
  const machine = verbFacts(method)?.machine
  if (!machine) return false
  if (machine === 'place') return placeSessionOf(args) !== null
  return method !== 'callProgram' || !hostsProgram(manifest, typeof args.server === 'string' ? args.server : undefined)
}

/** The session whose working copy a `machine: 'place'` call names (`place`, or the file `ref`), or null for a chat's. */
export function placeSessionOf(args: Record<string, unknown>): string | null {
  for (const named of [args.place, args.ref]) {
    const session = (named as { session?: unknown } | null | undefined)?.session
    if (typeof session === 'string' && session) return session
  }
  return null
}

/** Why the answering machine does not do this call for a page elsewhere, or null when it does. */
export function notOnSessionMachine(manifest: Pick<ExtensionManifest, 'contributes'>, method: string, args: Record<string, unknown>): Error | null {
  if (followsSessionMachine(manifest, method, args)) return null
  const message = verbFacts(method)?.machine ? HOSTED_PROGRAM_ELSEWHERE : `${method} is done where the page is, not on its session's machine`
  return Object.assign(new Error(message), { code: 'invalid' })
}

/** The one action a page's call travels in. `callId` names this call: sent again after a lost answer, it joins the first. */
export function appCallAction(target: string | { deviceId: string }, version: string, method: string, args: Record<string, unknown>, callId: string): AppCallAction {
  return { action: 'app_call', call_id: callId, ...(typeof target === 'string' ? { session_id: target } : { device_id: target.deviceId }), version, method, args }
}

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength

/**
 * A call and its answer are 1 MB each at most (`APP_CALL_MAX_BYTES`): over it the call is refused whole, never cut, in
 * the words of what was too large — a data file says it is the file, and that 1 MB is the limit across machines only.
 */
export function overCallLimit(side: 'call' | 'answer', action: Pick<AppCallAction, 'method' | 'args'>, value: unknown): Error | null {
  const bytes = bytesOf(value)
  if (bytes <= APP_CALL_MAX_BYTES) return null
  const size = `${Math.ceil(bytes / 1024)} KB`
  const path = typeof action.args.path === 'string' ? action.args.path : ''
  const message = action.method === 'readData' || action.method === 'writeData'
    ? `${path} is ${size}${side === 'answer' ? ' on the session\'s machine' : ''}; a page reads and writes a data file on another machine up to 1 MB (8 MB on its own machine)`
    : `The ${side} is ${size}; a page's call to another machine takes and returns at most 1 MB — page what is large`
  return Object.assign(new Error(message), { code: 'too-large' })
}

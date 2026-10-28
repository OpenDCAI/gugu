import { z } from 'zod'
import type { ExtensionInstallConsentResult } from './host-actions'

/**
 * Who agrees to an install, and where (D-31) — one meaning on every host (main's installPrepared, the phone's installs):
 * - `here`: asked here, when it asks — the sheet, or (an agent's install) the approval in its session;
 * - `return`: what it would ask is handed back instead (`asks` false when it would ask nothing), always, never installed —
 *   the caller asks in its own place (the Apps page, another device) and comes back with `given`;
 * - `given`: installs what the person agreed to — these bytes only (`digest`). Who gets its tools there is the install's
 *   own rule (`InstallGrant`), never carried with the yes: every computer applies it to itself.
 */
export type InstallConsent = { kind: 'here' } | { kind: 'return' } | { kind: 'given'; digest: string }

/** The consent another place hands an install (`return`, `given`) —— `here` is never handed in: it is where the install runs. */
export const handedConsentSchema = z.union([
  z.object({ kind: z.literal('return') }),
  z.object({ kind: z.literal('given'), digest: z.string().min(1) }),
])
export type HandedConsent = z.infer<typeof handedConsentSchema>

/**
 * The consent step of an install, the same everywhere: handed back (`return`), the bytes checked against the yes given
 * elsewhere (`given`), or asked here when it asks — then `install`.
 */
export async function agreeThenInstall<T>(
  ask: { manifestDigest: string },
  asks: boolean,
  consent: InstallConsent,
  askHere: () => Promise<ExtensionInstallConsentResult>,
  install: () => Promise<T>,
): Promise<{ outcome: 'ask' } | { outcome: Exclude<ExtensionInstallConsentResult['outcome'], 'confirmed'> } | { outcome: 'confirmed'; installed: T }> {
  if (consent.kind === 'return') return { outcome: 'ask' }
  if (consent.kind === 'given' && consent.digest !== ask.manifestDigest) {
    throw new Error('This App is not the one the person agreed to (it changed since): ask them again')
  }
  if (asks && consent.kind === 'here') {
    const answer = await askHere()
    if (answer.outcome !== 'confirmed') return { outcome: answer.outcome }
  }
  return { outcome: 'confirmed', installed: await install() }
}

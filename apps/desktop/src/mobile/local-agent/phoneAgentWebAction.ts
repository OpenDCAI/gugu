import type { DeviceActionOutcome, DeviceActionProvider } from '@gugu/core/cloud/deviceActionHost'
import type { PhoneAgentWebAction } from './nativeAgent'

/** Existing remote device actions keep their permission, validation and confirmation contract. */
export async function executePhoneAgentWebAction(
  request: PhoneAgentWebAction,
  deps: { ownerId(): string | null; provider(ownerId: string): DeviceActionProvider | null },
): Promise<DeviceActionOutcome> {
  const current = () => deps.ownerId() === request.ownerId
  if (!current()) return { ok: false, code: 'not_granted', message: '手机登录账号已改变' }
  const provider = deps.provider(request.ownerId)
  if (!provider) return { ok: false, code: 'device_offline', message: '手机动作通道尚未连接' }
  const before = await provider.permit(request.action)
  if (!before.ok) return before
  const preflight = await provider.preflight?.(request.action, request.args)
  if (preflight) return preflight
  if (!current()) return { ok: false, code: 'not_granted', message: '手机登录账号已改变' }
  const outcome = await provider.run(request.action, request.args, { callId: request.id, signal: AbortSignal.timeout(30_000), note: () => {} })
  if (!current()) return { ok: false, code: 'not_granted', message: '手机登录账号已改变，结果未交付' }
  const after = await provider.permit(request.action)
  return after.ok ? outcome : after
}

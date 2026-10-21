import type { GuguSettingsScope } from '../types/chat'

export function deviceSettingsScope(deviceId: string): GuguSettingsScope {
  return `device:${deviceId}`
}

// @@@device-ssh-target - Operator-scoped, per-device ssh args used only by the desktop when opening a
export function readDeviceSshTarget(config: Record<string, unknown> | null | undefined): string {
  const value = config?.ssh_target
  return typeof value === 'string' ? value.trim() : ''
}

export function mergeDeviceSshTarget(
  config: Record<string, unknown>,
  sshTarget: string,
): Record<string, unknown> {
  const next = { ...config }
  const trimmed = sshTarget.trim()
  if (trimmed) next.ssh_target = trimmed
  else delete next.ssh_target
  return next
}

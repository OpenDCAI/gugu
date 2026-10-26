export type PhoneAgentSetupStep = 'host' | 'notifications' | 'background' | 'tools'
export interface PhoneAgentSetupProgress { step: PhoneAgentSetupStep; dismissed: boolean; completed: boolean }

const PREFIX = 'gugu.phoneAgentSetup.v1:'
const steps: readonly PhoneAgentSetupStep[] = ['host', 'notifications', 'background', 'tools']
const requests = new Map<string, number>()
const listeners = new Set<() => void>()

function key(ownerId: string, installId: string): string {
  if (!ownerId || !installId) throw new Error('手机设置缺少账号或安装标识。')
  return PREFIX + encodeURIComponent(ownerId) + ':' + encodeURIComponent(installId)
}

/** This is presentation progress, never a grant or an instruction to start the native host. */
export function readPhoneAgentSetup(ownerId: string, installId: string): PhoneAgentSetupProgress {
  const raw = localStorage.getItem(key(ownerId, installId))
  if (!raw) return { step: 'host', dismissed: false, completed: false }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') throw new Error('手机设置进度损坏，请重新设置。')
  const saved = parsed as Partial<PhoneAgentSetupProgress>
  if (!steps.includes(saved.step as PhoneAgentSetupStep)) throw new Error('手机设置进度损坏，请重新设置。')
  return { step: saved.step as PhoneAgentSetupStep, dismissed: saved.dismissed === true, completed: saved.completed === true }
}

export function savePhoneAgentSetup(ownerId: string, installId: string, progress: PhoneAgentSetupProgress): void {
  localStorage.setItem(key(ownerId, installId), JSON.stringify(progress))
}

/** The existing device settings reopens the same guide; no second management route is created. */
export function openPhoneAgentSetup(ownerId: string): void {
  requests.set(ownerId, (requests.get(ownerId) ?? 0) + 1)
  for (const listener of listeners) listener()
}
export function phoneAgentSetupRequest(ownerId: string): number { return requests.get(ownerId) ?? 0 }
export function subscribePhoneAgentSetup(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

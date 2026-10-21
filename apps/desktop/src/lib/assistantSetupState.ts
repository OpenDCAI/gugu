import { useSyncExternalStore } from 'react'
// #7199 引导走到哪一步(记在这台电脑上,按账号):它安好家之后「连应用 → 一切就绪」两步由会话页画,中途退出再打开接着走。
// 没记 = 不在引导里(早就有它了 / 走完了 / 在别的设备上开通的 —— 那一边的人没看过引导,这台不补)。
import type { AssistantSetupStep } from './assistantShellBridge'

type Stored = Exclude<AssistantSetupStep, 'shell'>

const key = (ownerUserId: string) => `gugu.assistant.setup:${ownerUserId}`
const listeners = new Set<() => void>()

export function readSetupStep(ownerUserId: string | null | undefined): Stored | null {
  if (!ownerUserId) return null
  try {
    const raw = window.localStorage.getItem(key(ownerUserId))
    return raw === 'connect' || raw === 'ready' ? raw : null
  } catch {
    return null
  }
}

export function writeSetupStep(ownerUserId: string, step: Stored | null): void {
  try {
    if (step) window.localStorage.setItem(key(ownerUserId), step)
    else window.localStorage.removeItem(key(ownerUserId))
  } catch {
    // 记不住就算了:下次打开不在引导里,直接进 App。
  }
  for (const listener of [...listeners]) listener()
}

export function subscribeSetupStep(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// 「自定义」卡(product spec 开通那段,照 dots):开通成功后聊天里递一张「给我起个名字」的卡,点过或关掉就不再出现。
// 记在开通的这台设备上(按账号):卡只是指个路,名字和形象在自定义弹窗里改、哪台都能改。
const offerKey = (ownerUserId: string) => `gugu.assistant.offerCustomize:${ownerUserId}`
const offerListeners = new Set<() => void>()

export function offerCustomizeCard(ownerUserId: string): void {
  try {
    window.localStorage.setItem(offerKey(ownerUserId), '1')
  } catch {
    // 记不住 = 不递卡;入口在资料页头像上的笔一直都在。
  }
  for (const listener of [...offerListeners]) listener()
}

export function customizeCardOffered(ownerUserId: string | null | undefined): boolean {
  if (!ownerUserId) return false
  try {
    return window.localStorage.getItem(offerKey(ownerUserId)) === '1'
  } catch {
    return false
  }
}

export function retireCustomizeCard(ownerUserId: string): void {
  try {
    window.localStorage.removeItem(offerKey(ownerUserId))
  } catch {
    // 删不掉就下次再递一次,无害。
  }
  for (const listener of [...offerListeners]) listener()
}

export function subscribeCustomizeCard(listener: () => void): () => void {
  offerListeners.add(listener)
  return () => offerListeners.delete(listener)
}

/** 递没递过「自定义」卡(跟着点开 / 关掉实时变)。 */
export function useCustomizeCardOffered(ownerUserId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribeCustomizeCard, () => customizeCardOffered(ownerUserId))
}

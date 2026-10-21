import { connectorOrder } from '@/session/renderer/features/assistant/assistant-connector-order'
import type { PersonaPreset } from '@/session/renderer/features/assistant/assistant-files'

// #7199 手机 <它的名字> 那一格的纯判断(与桌面 assistant-profile / assistant-personality / assistant-capabilities 同一套说法),单测在
// tests/unit/mobile/phoneProfileModel7199.test.ts。读写在 usePhoneProfileData.ts,画法在 PhoneProfile / PhoneCustomize / PhoneConnectors。

export type Persona = { preset: PersonaPreset | null; rest: string }

/**
 * 资料页性格胶囊上的字:读到了照桌面(预设名 / 自定义性格 / 设置性格);还没读到(在休息、正在醒、读失败)只说「性格」——
 * ❌ 说「设置性格」(它可能早就有性格,只是此刻读不到)。
 */
export function personaChipKey(persona: Persona | null): string {
  if (!persona) return 'customize.character'
  if (persona.preset) return `customize.preset.${persona.preset}`
  return persona.rest ? 'customize.custom' : 'customize.setCharacter'
}

/**
 * 「自定义」那一个「保存」要做的事:名字变了才改名(空名不许存);性格动过、且读到过原文才写(没读到就写 = 拿空白盖掉它原来的性格)。
 */
export function customizePlan({
  draftName,
  currentName,
  personaTouched,
  personaReadable,
}: {
  draftName: string
  currentName: string
  personaTouched: boolean
  personaReadable: boolean
}): { rename: string | null; writePersona: boolean; canSave: boolean } {
  const trimmed = draftName.trim()
  return {
    rename: trimmed && trimmed !== currentName ? trimmed : null,
    writePersona: personaTouched && personaReadable,
    canSave: !!trimmed,
  }
}

export type ConnectorItem = { id: string; description: string }
export type ConnectorStatus = { displayName?: string }

/**
 * 云端连接应用分「已连接 / 可用」两组(照桌面 ConnectorLists):连没连按存没存凭据算(不联网那一问),
 * 已连接那一行副标题写账号名(联网那一问给的,还没问到就写介绍),先后照 connectorOrder(中文用户国内常用的在前)。
 */
export function connectorGroups<T extends ConnectorItem>(
  items: readonly T[],
  configured: Partial<Record<string, boolean>>,
  statuses: Partial<Record<string, ConnectorStatus>> | null,
  language: string,
): { connected: { item: T; detail: string }[]; available: { item: T; detail: string }[] } {
  const ordered = connectorOrder(items, language)
  return {
    connected: ordered.filter((item) => configured[item.id]).map((item) => ({ item, detail: statuses?.[item.id]?.displayName ?? item.description })),
    available: ordered.filter((item) => !configured[item.id]).map((item) => ({ item, detail: item.description })),
  }
}

/** 一家的详情:不在目录里 = null(页面说「此应用不可用」,❌ 画一张空详情)。 */
export function connectorDetail<T extends ConnectorItem>(
  items: readonly T[],
  configured: Partial<Record<string, boolean>>,
  statuses: Partial<Record<string, ConnectorStatus>> | null,
  id: string,
): { item: T; connected: boolean; account: string | null } | null {
  const item = items.find((candidate) => candidate.id === id)
  if (!item) return null
  return { item, connected: !!configured[id], account: statuses?.[id]?.displayName ?? null }
}

/**
 * 「本机」那一段在手机上说的是这台手机:装在手机上的咕咕(capacitor)画「这台手机」能做的事(PhoneDeviceActionsPage);
 * 别的(手机浏览器里的网页版)交给桌面同一个 ThisDeviceConnectors —— 没有设备能力时它说「要在咕咕电脑 App 里连接」。
 */
export function thisDeviceView(platformKind: 'electron' | 'capacitor' | 'web'): 'phone' | 'shared' {
  return platformKind === 'capacitor' ? 'phone' : 'shared'
}

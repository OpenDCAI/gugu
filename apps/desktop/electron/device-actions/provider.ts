/**
 * #7199 把各动作族(families/*)拼成这台电脑的设备动作:授权判定(分组 → 逐个工具 → 全部拒绝)、登记清单、「连接」时碰系统授权、
 * 把各种失败统一成设备动作的错误码。族里只写动作本身。
 */
import {
  DEVICE_ACTION_CONFIRMED_ARG,
  DEVICE_ACTION_PROTOCOL_VERSION,
  type DeviceActionErrorCode,
  type DeviceActionManifestEntry,
  type DeviceActionsCapability,
} from '@gugu/core/shared/deviceActions'
import type { DeviceActionPermit, DeviceActionProvider, DeviceActionRunContext } from '@gugu/core/cloud/deviceActionHost'
import type { ActionDef, ActionFamily, ActionGroupDef, FamilyContext, FamilyDeps, Outcome } from './catalog'
import type { DeviceActionGrantsStore } from './grants-store'
import { MacScriptPermissionError } from './mac-scripts'
import { NativeCallError } from './native/mac-helper-client'
import { FILE_ROOTS, grantedRootTitles } from './paths'

const KNOWN_CODES: ReadonlySet<string> = new Set<DeviceActionErrorCode>([
  'unknown_action', 'not_granted', 'os_permission', 'invalid_args', 'needs_confirmation', 'execution_failed', 'timeout', 'unsupported',
])

/**
 * 结果里一张图(base64)的上限。结果要过设备频道(Realtime 广播)回到调用方,太大会被丢;
 * 超过的先缩到模型看图的甜区(长边 1568 的 JPEG),还大就再缩一档,仍超就不带图、如实说。
 */
const PICTURE_MAX_BASE64 = 700_000

export type ConnectResult =
  | { ok: true }
  | { ok: false; code: 'os_permission' | 'execution_failed' | 'unsupported' | 'unknown_group'; message: string; settingsUrl?: string; restart?: true }

export interface DeviceActionsProvider {
  provider: DeviceActionProvider
  capability(): DeviceActionsCapability | null
  /** 这台电脑这个平台上有的分组(界面顺序)。 */
  groups(): readonly ActionGroupDef[]
  /** 一组名下的动作(文件四个根都回 files 那些动作)。 */
  actionsOf(group: string): readonly ActionDef[]
  /** 这个动作在这台电脑上做不了的原因(见 ActionDef.unsupportedReason);做得了回 null。 */
  unsupportedReason(action: string): string | null
  /** 一组现在为什么不能用:原生程序不在(unsupported),或上一次碰到系统权限没给(os_permission)。 */
  blocked(group: string): { reason: 'unsupported' | 'os_permission'; message: string } | null
  connect(group: string): Promise<ConnectResult>
  disconnect(group: string): void
}

/** 把一个错误统一成设备动作的结果(族里抛什么都行,这里收口)。 */
export function outcomeOfError(error: unknown, appTitle: string): Outcome {
  if (error instanceof MacScriptPermissionError) {
    return error.pending
      ? { ok: false, code: 'os_permission', message: `"${error.app}" did not answer: macOS is most likely asking on this computer whether 咕咕 may control ${error.app}. Click "Allow" there, then retry.` }
      : { ok: false, code: 'os_permission', message: `macOS has not allowed 咕咕 to control "${error.app}": System Settings → Privacy & Security → Automation → 咕咕 → turn on "${error.app}", then retry.` }
  }
  if (error instanceof NativeCallError) {
    const code = KNOWN_CODES.has(error.code) ? (error.code as DeviceActionErrorCode) : 'execution_failed'
    return code === 'needs_confirmation'
      ? { ok: false, code, message: error.message, confirm: { question: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } }
      : { ok: false, code, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'execution_failed', message: `${appTitle}: ${message}` }
}

export function createDeviceActionsProvider(input: {
  store: DeviceActionGrantsStore
  families: readonly ActionFamily[]
  deps: FamilyDeps
  /** 给人看的分组名(不可用说明里用):缺省用 id。 */
  groupTitle?(group: string): string
  /**
   * 开关在一个 App 上的分组(#7317:电脑控制的开关是 Computer Use):null = 不是;否则 on 就是连上了(❌ 设置里另有一个
   * 「连接」),关着时这组的动作不登记(agent 看不到、不占 token),点名调用回 offMessage。
   */
  managedBy?(group: string): { on: boolean; offMessage: string } | null
}): DeviceActionsProvider {
  const { store, deps } = input
  const platform = deps.platform
  const groups = input.families.flatMap((f) => f.groups).filter((g) => g.platforms.includes(platform))
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const actions = input.families.flatMap((f) => f.actions).filter((a) => {
    const platforms = a.platforms ?? (a.group === 'files' ? groupById.get('files.desktop')?.platforms : groupById.get(a.group)?.platforms) ?? []
    return platforms.includes(platform) && (a.group === 'files' ? FILE_ROOTS.some((r) => groupById.has(r)) : groupById.has(a.group))
  })
  const byName = new Map(actions.map((a) => [a.name, a]))
  const osBlocked = new Map<string, string>()
  const title = (group: string) => (group === 'files' ? 'Files' : input.groupTitle?.(group) ?? group)

  const managed = (group: string) => input.managedBy?.(group) ?? null
  /** 连上的分组:设置里连上的(原样,文件那几个根也在里面),开关在 App 上的则只看那个 App 开没开。 */
  const grantedOf = (stored: Record<string, unknown>): ReadonlySet<string> => {
    const granted = new Set(Object.keys(stored))
    for (const g of groups) {
      const m = managed(g.id)
      if (m?.on) granted.add(g.id)
      else if (m) granted.delete(g.id)
    }
    return granted
  }
  const grantedSet = (): ReadonlySet<string> => grantedOf(store.read().groups)
  const groupGranted = (group: string, granted: ReadonlySet<string>) =>
    group === 'files' ? FILE_ROOTS.some((r) => granted.has(r)) : granted.has(group)
  /** 这个动作的分组开关在 App 上、而 App 关着:这台电脑就没有它。 */
  const switchedOff = (group: string) => {
    const m = managed(group)
    return m && !m.on ? m : null
  }
  /** 动作所在的那几个分组(文件动作 = 四个根)。 */
  const groupsOf = (group: string) => (group === 'files' ? FILE_ROOTS.filter((r) => groupById.has(r)) : [group])

  const nativeMissing = (group: string): string | null => {
    const def = groupById.get(group)
    if (def?.needs === 'macHelper') {
      const r = deps.macHelper().available()
      return r.ok ? null : r.message
    }
    if (def?.needs === 'cua') {
      const r = deps.cua().available()
      return r.ok ? null : r.message
    }
    return null
  }

  const notGrantedDetail = (group: string) => group === 'files'
    ? 'On that computer, open 咕咕 → Settings → Devices → What this computer can do, and connect the locations needed (Desktop / Documents / Downloads / Other locations).'
    : `On that computer, open 咕咕 → Settings → Devices → What this computer can do, and connect "${title(group)}".`

  const markOs = (group: string, outcome: Outcome): Outcome => {
    for (const g of groupsOf(group)) {
      if (outcome.ok) osBlocked.delete(g)
      else if (outcome.code === 'os_permission') osBlocked.set(g, outcome.message)
    }
    return outcome
  }

  const permit = (action: string): DeviceActionPermit => {
    const def = byName.get(action)
    if (!def) return { ok: false, code: 'unknown_action', message: `This computer has no action ${action}` }
    const off = switchedOff(def.group)
    if (off) return { ok: false, code: 'not_granted', message: off.offMessage }
    const grants = store.read()
    if (grants.denyAll) return { ok: false, code: 'not_granted', message: 'This computer is set to "Deny all": no action may be called. It can be turned off in 咕咕 → Settings → Devices → What this computer can do.' }
    const granted = grantedOf(grants.groups)
    if (!groupGranted(def.group, granted)) return { ok: false, code: 'not_granted', message: `This computer has not allowed "${title(def.group)}": ${notGrantedDetail(def.group)}` }
    if (grants.deniedActions.includes(action)) {
      return { ok: false, code: 'not_granted', message: `This computer turned off "${def.titleEn}" (${action}) on its own; it can be turned back on in 咕咕 → Settings → Devices → What this computer can do → ${title(def.group)}.` }
    }
    const missing = groupsOf(def.group).map(nativeMissing).find(Boolean) ?? def.unsupportedReason?.(deps)
    if (missing) return { ok: false, code: 'unsupported', message: missing }
    return { ok: true }
  }

  const familyContext = (signal: AbortSignal, note: (text: string) => void): FamilyContext => ({ deps, granted: grantedSet, signal, note })

  const shrinkPictures = async (outcome: Outcome): Promise<Outcome> => {
    if (!outcome.ok || !outcome.data || typeof outcome.data !== 'object' || !Array.isArray((outcome.data as { pictures?: unknown }).pictures)) return outcome
    const data = outcome.data as { pictures: Array<{ label: string; mimeType: string; data: string }> } & Record<string, unknown>
    const pictures: typeof data.pictures = []
    const omitted: string[] = []
    for (const picture of data.pictures) {
      let current = picture
      for (const maxEdge of [1568, 1024]) {
        if (current.data.length <= PICTURE_MAX_BASE64 || !deps.shrinkImage) break
        const small = await deps.shrinkImage(picture, { maxEdge, quality: 72 })
        current = { label: picture.label, mimeType: small.mimeType, data: small.data }
      }
      if (current.data.length <= PICTURE_MAX_BASE64) pictures.push(current)
      else omitted.push(picture.label)
    }
    return {
      ok: true,
      data: {
        ...data,
        pictures,
        ...(omitted.length > 0 ? { pictures_omitted: `${omitted.join(', ')}: too large to send back even after shrinking` } : {}),
      },
    }
  }

  const capability = (): DeviceActionsCapability | null => {
    if (actions.length === 0) return null
    const grants = store.read()
    const granted = grantedOf(grants.groups)
    // A group whose App is off is not this computer's at all: not listed, so no agent reads it (and no token is spent).
    const entries: DeviceActionManifestEntry[] = actions.filter((def) => !switchedOff(def.group)).map((def) => {
      const roots = grantedRootTitles(granted)
      const base = {
        name: def.name,
        group: def.group,
        title: def.title,
        description: def.group === 'files' && roots.length > 0 ? `${def.description} Connected locations: ${roots.join(', ')}.` : def.description,
        risk: def.risk,
        confirm: def.confirm,
        input_schema: def.input_schema,
      }
      if (grants.denyAll) return { ...base, available: false, unavailable_reason: 'not_granted' as const, unavailable_detail: 'This computer is set to "Deny all" in 咕咕 → Settings → Devices.' }
      if (!groupGranted(def.group, granted)) return { ...base, available: false, unavailable_reason: 'not_granted' as const, unavailable_detail: notGrantedDetail(def.group) }
      if (grants.deniedActions.includes(def.name)) return { ...base, available: false, unavailable_reason: 'not_granted' as const, unavailable_detail: `Turned off on its own in 咕咕 → Settings → Devices → ${title(def.group)}.` }
      const missing = groupsOf(def.group).map(nativeMissing).find(Boolean) ?? def.unsupportedReason?.(deps)
      if (missing) return { ...base, available: false, unavailable_reason: 'unsupported' as const, unavailable_detail: missing }
      const blockedMessage = groupsOf(def.group).filter((g) => granted.has(g)).map((g) => osBlocked.get(g)).find(Boolean)
      if (blockedMessage) return { ...base, available: false, unavailable_reason: 'os_permission' as const, unavailable_detail: blockedMessage }
      return { ...base, available: true }
    })
    // …but a caller naming one of its actions is told the App is off, not "no such action".
    const off = groups.flatMap((g) => {
      const m = switchedOff(g.id)
      return m ? [{ group: g.id, detail: m.offMessage }] : []
    })
    return {
      v: DEVICE_ACTION_PROTOCOL_VERSION,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      actions: entries,
      ...(off.length > 0 ? { switched_off: off } : {}),
    }
  }

  const provider: DeviceActionProvider = {
    manifest: () => capability()?.actions ?? [],
    permit,
    preflight(action, args) {
      const def = byName.get(action)
      if (!def) return null
      const problem = def.validate?.(args)
      if (problem) return { ok: false, code: 'invalid_args', message: problem }
      if (def.confirm === 'always' && !def.confirmsItself && args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
        return {
          ok: false,
          code: 'needs_confirmation',
          message: 'The person must confirm this action first',
          confirm: { question: def.question?.(args) ?? `Do "${def.titleEn}" on this computer?` },
        }
      }
      return null
    },
    async run(action, args, ctx: DeviceActionRunContext) {
      const def = byName.get(action)
      if (!def) return { ok: false, code: 'unknown_action', message: `This computer has no action ${action}` }
      try {
        const outcome = await shrinkPictures(await def.run(args, { ...familyContext(ctx.signal, ctx.note), callId: ctx.callId, ...(ctx.caller ? { caller: ctx.caller } : {}), ...(ctx.remainingMs ? { remainingMs: ctx.remainingMs } : {}) }))
        return def.succeedsWithoutPermission && outcome.ok ? outcome : markOs(def.group, outcome)
      } catch (error) {
        return markOs(def.group, outcomeOfError(error, def.titleEn))
      }
    },
    record: (entry) => store.record(entry),
  }

  return {
    provider,
    capability,
    groups: () => groups,
    actionsOf: (group) => {
      const def = groupById.get(group)
      return actions.filter((a) => a.group === group || (def?.section === 'files' && a.group === 'files'))
    },
    unsupportedReason: (action) => byName.get(action)?.unsupportedReason?.(deps) ?? null,
    blocked(group) {
      const missing = nativeMissing(group)
      if (missing) return { reason: 'unsupported', message: missing }
      const os = osBlocked.get(group)
      return os ? { reason: 'os_permission', message: os } : null
    },
    async connect(group) {
      const def = groupById.get(group)
      if (!def) return { ok: false, code: 'unknown_group', message: `No such group: ${group}` }
      const off = switchedOff(group)
      if (off) return { ok: false, code: 'unsupported', message: off.offMessage }
      const missing = nativeMissing(group)
      if (missing) return { ok: false, code: 'unsupported', message: missing }
      if (def.probe) {
        let outcome: Outcome
        try {
          outcome = await def.probe(familyContext(AbortSignal.timeout(180_000), () => undefined))
        } catch (error) {
          outcome = outcomeOfError(error, group)
        }
        markOs(group, outcome)
        if (!outcome.ok) {
          const code = outcome.code === 'os_permission' ? 'os_permission' : 'execution_failed'
          // The page of the permission that is missing (a group can need several), else the group's own.
          const { settingsUrl: missingPane, restart } = outcome as { settingsUrl?: unknown; restart?: unknown }
          const settingsUrl = typeof missingPane === 'string' ? missingPane : def.settingsUrl
          return {
            ok: false, code, message: outcome.message,
            ...(code === 'os_permission' && settingsUrl ? { settingsUrl } : {}),
            // macOS applies the permission only once 咕咕 restarts (Screen Recording).
            ...(code === 'os_permission' && restart === true ? { restart: true as const } : {}),
          }
        }
      }
      // A group switched by its App is connected by the App alone: this only asked the system for what it needs.
      if (!managed(group)) store.setGroup(group, true)
      return { ok: true }
    },
    disconnect(group) {
      store.setGroup(group, false)
    },
  }
}

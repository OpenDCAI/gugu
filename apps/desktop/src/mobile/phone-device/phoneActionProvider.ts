/**
 * #7199 手机当设备 —— 交给 core 的设备动作 host(@gugu/core/cloud/deviceActionHost)的那份 provider。
 * 收发规矩(收到 / 进度 / 结果 / 重推 / 去重 / 授权三查)整份在 host 里,桌面与手机共用一份;
 * 这里只回答三件事:这台手机此刻能不能做这个动作、开工前要不要先问人、怎么做。
 */
import { PhoneDataFailure } from './phoneDataActions'
import { nativeFailure } from './nativePhoneActions'
import { DEVICE_ACTION_CONFIRMED_ARG, type DeviceActionManifestEntry } from '@gugu/core/shared/deviceActions'
import type { DeviceActionCallRecord, DeviceActionPermit, DeviceActionProvider } from '@gugu/core/cloud/deviceActionHost'
import {
  PhoneActionFailure,
  requirementMet,
  type PhoneActionDefinition,
  type PhoneActionGroup,
  type PhoneOsState,
} from './phoneActionCatalog'

export interface PhoneActionProviderDeps {
  action: (name: string) => PhoneActionDefinition | undefined
  /** 用户此刻在咕咕里开没开这一组(连同总开关)。 */
  granted: (group: PhoneActionGroup) => boolean
  /** 系统此刻给了什么;还没读到 = null(那时不拦,原生层自己会报 os_permission)。 */
  os: () => PhoneOsState | null
  manifest: () => DeviceActionManifestEntry[]
  record?: (entry: DeviceActionCallRecord) => void
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createPhoneActionProvider(deps: PhoneActionProviderDeps): DeviceActionProvider {
  return {
    manifest: deps.manifest,
    permit: (name): DeviceActionPermit => {
      const action = deps.action(name)
      if (!action) return { ok: false, code: 'unknown_action', message: `这台手机没有「${name}」这个动作` }
      if (!deps.granted(action.group)) {
        return { ok: false, code: 'not_granted', message: '用户没在手机上的咕咕里连上这一组(我的 → 这台手机)' }
      }
      const os = deps.os()
      if (!os) return { ok: true }
      const met = requirementMet(action.requires, os)
      if (met.ok) return { ok: true }
      // 合同里的 unsupported 指「咕咕太旧不认协议」;手机做不了(没有时钟 App)归执行失败,原因写在 message 里。
      return { ok: false, code: met.reason === 'os_permission' ? 'os_permission' : 'execution_failed', message: met.detail }
    },
    preflight: (name, args) => {
      const action = deps.action(name)
      if (!action || action.confirm !== 'always' || args[DEVICE_ACTION_CONFIRMED_ARG] === true) return null
      try {
        const confirm = action.confirmQuestion ? action.confirmQuestion(args) : { question: `要让手机「${action.title}」吗?` }
        return { ok: false, code: 'needs_confirmation', message: confirm.question, confirm }
      } catch (error) {
        // 参数都不对,❌ 拿去问人。
        return { ok: false, code: error instanceof PhoneActionFailure ? error.code : 'invalid_args', message: errorText(error) }
      }
    },
    run: async (name, args) => {
      const action = deps.action(name)
      if (!action) return { ok: false, code: 'unknown_action', message: `这台手机没有「${name}」这个动作` }
      try {
        return { ok: true, data: await action.run(args) }
      } catch (error) {
        if (error instanceof PhoneActionFailure || error instanceof PhoneDataFailure) return { ok: false, code: error.code, message: error.message }
        const failure = nativeFailure(error)
        if (failure.code === 'os_permission' || failure.code === 'invalid_args') return { ok: false, code: failure.code, message: failure.message }
        return { ok: false, code: 'execution_failed', message: `执行失败:${errorText(error)}` }
      }
    },
    ...(deps.record ? { record: deps.record } : {}),
  }
}

/** host 每次开始 / 结束都交一条同 callId 的记录:合并进「最近调用」,新的在前,最多 limit 条。 */
export function mergeCallRecord<T extends DeviceActionCallRecord>(list: readonly T[], entry: T, limit: number): T[] {
  const index = list.findIndex((item) => item.callId === entry.callId)
  if (index >= 0) {
    const next = [...list]
    next[index] = { ...list[index], ...entry }
    return next
  }
  return [entry, ...list].slice(0, limit)
}

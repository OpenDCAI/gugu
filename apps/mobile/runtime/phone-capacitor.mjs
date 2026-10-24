import { AsyncLocalStorage } from 'node:async_hooks'

const calls = new AsyncLocalStorage()

/** Android and the WebView execute the same action definitions; only this byte transport changes. */
export const withPhoneNativeContext = (context, work) => calls.run(context, work)
export function registerPlugin(plugin) {
  return new Proxy({}, { get(_target, method) {
    if (method === 'then' || typeof method !== 'string') return undefined
    return async (args = {}) => {
      const context = calls.getStore()
      if (!context) throw new Error('手机原生调用缺少所属任务')
      const { nativeCall, signal, recordPermissionRequirements, recordNativeFailure, ...metadata } = context
      let result
      try {
        result = await nativeCall('phone.native', { plugin, method, args }, signal, metadata)
        if (!result?.ok) throw Object.assign(new Error(result?.message ?? '手机工具执行失败'), { code: result?.code ?? 'failed' })
      } catch (error) { recordNativeFailure?.(error); throw error }
      if (result.permissionRequirements) await recordPermissionRequirements?.(result.permissionRequirements)
      return result.data
    }
  } })
}

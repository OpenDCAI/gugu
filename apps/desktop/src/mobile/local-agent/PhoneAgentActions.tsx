import { useEffect } from 'react'
import { getRendererSession } from '@/lib/sessionPublication'
import { rendererLogger } from '@/lib/log'
import { getPhoneDeviceActionProvider } from '../phone-device/phoneDeviceRuntime'
import { nativeAgent, phoneAgentAvailable } from './nativeAgent'
import { executePhoneAgentWebAction } from './phoneAgentWebAction'

/** Compatibility bridge for existing actions that still require the foreground page. */
export function PhoneAgentActions(): null {
  useEffect(() => {
    if (!phoneAgentAvailable()) return
    let disposed = false
    const pending = nativeAgent.addListener('webAction', (request) => {
      void (async () => {
        const result = await executePhoneAgentWebAction(request, {
          ownerId: () => disposed ? null : getRendererSession()?.user.id ?? null,
          provider: getPhoneDeviceActionProvider,
        })
        await nativeAgent.webActionResult({ ownerId: request.ownerId, id: request.id, result })
      })().catch((error: unknown) => rendererLogger('phone-agent-actions').warn({ error }, '手机动作未能返回'))
    })
    return () => { disposed = true; void pending.then((listener) => listener.remove()) }
  }, [])
  return null
}

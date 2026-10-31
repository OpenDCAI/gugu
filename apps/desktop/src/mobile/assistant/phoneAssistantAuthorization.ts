import { i18n } from '@/i18n/runtime'
import '@/i18n/registerAssistantCatalog'
import type { AssistantHomePlace } from '@/lib/assistantHome'
import { wakeCloudComputer } from '@/lib/cloudComputerStore'
import { waitForAssistantControl } from '@/lib/assistantControlReady'
import { isAssistantActionRefusal } from '@/lib/assistantActionRefusal'
import { getRendererSession } from '@/lib/sessionPublication'
import { machineRpc } from '../agent-watch/sessionpage-rpc'

/** Constructing the API is inert. Only an explicit authorization mutation can
 * prepare its existing host; cancel/progress never start one. */
export function phoneAssistantAuthorization(deviceId: string, home: AssistantHomePlace | null) {
  const native = machineRpc(deviceId), ownerId = getRendererSession()?.user.id
  let preparing: Promise<void> | null = null
  function assertOwner() { if (!ownerId || getRendererSession()?.user.id !== ownerId) throw new Error(i18n.t('assistant:machine.accessFailed')) }
  async function prepare() {
    assertOwner()
    preparing ??= (async () => {
      if (home?.kind === 'cloud') {
        try { await wakeCloudComputer() }
        catch (cause) { throw new Error(i18n.t('assistant:machine.authorizationUnavailable'), { cause }) }
      }
      try { await waitForAssistantControl(() => native.integrations.checkConfiguredConnections(), assertOwner) }
      catch (cause) {
        assertOwner()
        if (isAssistantActionRefusal(cause)) throw cause
        throw new Error(i18n.t('assistant:machine.authorizationUnavailable'), { cause })
      }
    })().catch(error => { preparing = null; throw error })
    const current = preparing
    try { await current; assertOwner() }
    finally { if (preparing === current) preparing = null }
  }
  const integrations = new Proxy(native.integrations,{
    get(target,key,receiver) {
      const method = Reflect.get(target,key,receiver)
      if (['connect','authorize','cliLoginStart','cliToolPrepare'].includes(String(key))) return async (...args: unknown[]) => {
        await prepare()
        return method(...args)
      }
      return method
    },
  })
  const github = new Proxy(native.github,{
    get(target,key,receiver) {
      const method = Reflect.get(target,key,receiver)
      if (key === 'auth') return async (...args: unknown[]) => { await prepare(); return method(...args) }
      return method
    },
  })
  return new Proxy(native,{ get(target,key,receiver) {
    if (key === 'integrations') return integrations
    if (key === 'github') return github
    return Reflect.get(target,key,receiver)
  } })
}

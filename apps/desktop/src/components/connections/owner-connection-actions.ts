import { ConnectionError } from '@gugu/core/cloud/connections'
import type { IntegrationCredentials } from '@gugu/session-plugins/integrations'
import { connectionBridge } from '@/lib/connectionBridge'
import { rendererPlatformIntegrationsClient } from '@/lib/platformIntegrations'
import { openAuthorizationLink } from '@/lib/openAuthorizationLink'
import { rendererLogger } from '@/lib/log'
import type { LibraryHost } from '@/session/renderer/features/library/library-host'
import { builtinConnectionCatalog } from './builtin-connection-catalog'
import { createConnectionAuthorization, type ConnectionAuthorizationIntent } from './connection-authorization'

/** Existing credential services perform the authorization. Only their public
 * result is committed through the separately acquired owner intent. */
export function ownerConnectionActions(base: LibraryHost, host: LibraryHost,deviceId: string | null): LibraryHost {
  const bridge = connectionBridge(),store = host.connectionMetadata!
  const intents = createConnectionAuthorization({ client: { ...bridge.client,
    commit: change => {
      if (change.scopeKey === 'platform') return bridge.client.commit(change)
      if (!base.integrations.ownerAuthorizationCommit || !change.recreationId || typeof change.data?.providerId !== 'string' || typeof change.data.accountId !== 'string')
        throw new ConnectionError('unsupported-device','CONNECTION_DEVICE_UNSUPPORTED')
      return base.integrations.ownerAuthorizationCommit({ operationId: change.operationId,scopeKey: change.scopeKey,resourceKey: change.resourceKey,
        expectedRevision: change.expectedRevision,recreationId: change.recreationId,providerId: change.data.providerId,accountId: change.data.accountId })
    },
    commitBatch: change => {
      if (!base.integrations.ownerAuthorizationCommitBatch) throw new ConnectionError('unsupported-device','CONNECTION_DEVICE_UNSUPPORTED')
      return base.integrations.ownerAuthorizationCommitBatch({ operationId: change.operationId,recreationId: change.recreationId,
        providerId: String(change.operations[0]?.data.providerId),operations: change.operations.map(row => ({ operationId: row.operationId,accountId: String(row.data.accountId) })) })
    },
  },accountId: bridge.accountId,changed: () => store.invalidate() })
  const cli = new Map<string,ConnectionAuthorizationIntent>()
  const browsers = new Map<string,AbortController>()
  const keptOnPlatform = (provider: string) => builtinConnectionCatalog('en-US').find(row => row.id === provider)?.auth.methods
    .some(method => (method.kind === 'form' || method.kind === 'mcp-oauth') && method.custody === 'platform') ?? false
  async function beginNative(provider: string,accountId: string | null = null) {
    if (!deviceId) throw new ConnectionError('device-required','CONNECTION_DEVICE_REQUIRED')
    await host.prepareAssistantAction?.()
    if (!base.integrations.ownerAuthorizationBegin || !base.integrations.ownerAccounts || !base.integrations.ownerAuthorizationComplete)
      throw new ConnectionError('unsupported-device','CONNECTION_DEVICE_UNSUPPORTED')
    const operationId = crypto.randomUUID()
    await base.integrations.ownerAuthorizationBegin(provider,operationId)
    return intents.begin(provider,`device:${deviceId}`,deviceId,accountId,operationId)
  }
  async function completeNative(intent: ConnectionAuthorizationIntent,accountId: string | undefined) {
    if (!accountId) throw new ConnectionError('invalid-response','CONNECTION_AUTHORIZATION_ACCOUNT_MISSING')
    const rows = await base.integrations.ownerAccounts!(intent.providerId)
    const row = rows.find(row => row.accountId === accountId)
    if (!row) throw new ConnectionError('invalid-response','CONNECTION_AUTHORIZATION_ACCOUNT_MISSING')
    const { publicMetadata,...data } = row
    await intents.complete(intent,data,publicMetadata)
    await base.integrations.ownerAuthorizationComplete!(intent.providerId,intent.operationId)
  }
  async function completePlatform(intent: ConnectionAuthorizationIntent) {
    const rows = (await rendererPlatformIntegrationsClient().list()).find(row => row.provider === intent.providerId)?.accounts ?? []
    if (rows.length !== 1 || !rows[0]!.connected) throw new ConnectionError('identity-changed','CONNECTION_AUTHORIZATION_ACCOUNT_CHANGED')
    const row = rows[0]!,updatedAt = row.updatedAt ? Date.parse(row.updatedAt) : NaN
    if (!Number.isFinite(updatedAt)) throw new ConnectionError('invalid-response','CONNECTION_AUTHORIZATION_ACCOUNT_MISSING')
    await intents.complete(intent,{ providerId: intent.providerId,accountId: row.accountId,configured: true,isDefault: true,
      ...(row.checkedAt ? { checkResult: 'ok',checkedAt: Date.parse(row.checkedAt) } : {}) },
    { version: 1,providerId: intent.providerId,accountId: row.accountId,isDefault: true,credentialSource: 'platform',connectedAt: updatedAt,updatedAt })
  }
  async function connect(provider: string,credentials: IntegrationCredentials,editAccountId?: string) {
    if (keptOnPlatform(provider)) {
      const intent = await intents.begin(provider,'platform',null,editAccountId ?? null)
      const fields = Object.fromEntries(Object.entries(credentials).filter((entry): entry is [string,string] => typeof entry[1] === 'string'))
      await rendererPlatformIntegrationsClient().saveCredential(provider,fields,{ connect: 'manual' })
      await completePlatform(intent)
      return { success: true as const }
    }
    const intent = await beginNative(provider,editAccountId ?? null)
    const result = await base.integrations.connect(provider,credentials,editAccountId,true)
    if (result.success) await completeNative(intent,result.accountId)
    return result
  }
  async function authorize(provider: string) {
    if (!keptOnPlatform(provider)) {
      const intent = await beginNative(provider)
      const result = await base.integrations.authorize(provider,true)
      if (result.success) await completeNative(intent,result.accountId)
      return result
    }
    browsers.get(provider)?.abort()
    const controller = new AbortController(),signal = controller.signal
    browsers.set(provider,controller)
    const client = rendererPlatformIntegrationsClient()
    const intent = await intents.begin(provider,'platform',null)
    const attempt = await client.beginOAuth!(provider,signal)
    try {
      await openAuthorizationLink(attempt.authorizationUrl)
      while (Date.now() < attempt.expiresAt) {
        signal.throwIfAborted()
        const status = await client.oauthStatus!(provider,attempt.attemptId,signal)
        if (status.state === 'connected') { await completePlatform(intent); return { success: true as const } }
        if (status.state === 'failed') throw new ConnectionError('authorization-failed','CONNECTION_AUTHORIZATION_FAILED')
        await new Promise<void>((resolve,reject) => {
          const finish = () => { signal.removeEventListener('abort',cancel); resolve() }
          const timer = setTimeout(finish,1000)
          const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort',cancel); reject(signal.reason) }
          signal.addEventListener('abort',cancel,{ once: true })
        })
      }
      throw new ConnectionError('authorization-expired','CONNECTION_AUTHORIZATION_EXPIRED')
    } finally {
      if (browsers.get(provider) === controller) browsers.delete(provider)
      await client.cancelOAuth!(provider,attempt.attemptId).catch(() => rendererLogger('connections').warn({ provider },'Authorization cleanup did not reach the platform'))
    }
  }
  return { ...host,integrations: { ...host.integrations,connect,authorize,
    async cliLoginStart(provider) {
      const intent = await beginNative(provider)
      cli.set(provider,intent)
      const result = await base.integrations.cliLoginStart(provider,true)
      if (result.success && 'connected' in result) { await completeNative(intent,result.accountId); cli.delete(provider) }
      return result
    },
    async cliLoginWait(provider) {
      const intent = cli.get(provider)
      if (!intent) throw new ConnectionError('intent-missing','CONNECTION_AUTHORIZATION_EXPIRED')
      const result = await host.integrations.cliLoginWait(provider)
      if (result.status === 'connected') { await completeNative(intent,result.accountId); cli.delete(provider) }
      return result
    },
    async cancelAuthorization(provider) { cli.delete(provider); browsers.get(provider)?.abort(); await host.integrations.cancelAuthorization(provider) },
  },github: { ...host.github,
    async importCliAccounts() {
      const intent = await beginNative('github')
      const result = await base.github.importCliAccounts()
      if (result.success && result.importedAccountIds.length) {
        const rows = await base.integrations.ownerAccounts!('github')
        const accounts = result.importedAccountIds.map(id => {
          const row = rows.find(row => row.accountId === id)
          if (!row) throw new ConnectionError('invalid-response','CONNECTION_AUTHORIZATION_ACCOUNT_MISSING')
          const { publicMetadata,...data } = row
          return { data,publicMetadata }
        })
        await intents.completeBatch(intent,accounts)
        await base.integrations.ownerAuthorizationComplete!('github',intent.operationId)
      }
      return result
    },
    async auth() {
      const intent = await beginNative('github')
      const result = await base.github.auth()
      if (result.success) await completeNative(intent,result.account.accountId)
      return result
    },
  } }
}

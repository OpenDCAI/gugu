import { ConnectionError } from '@gugu/core/cloud/connections'
import type { IntegrationCredentials } from '@gugu/session-plugins/integrations'
import { connectionBridge } from '@/lib/connectionBridge'
import { rendererPlatformIntegrationsClient } from '@/lib/platformIntegrations'
import { openAuthorizationLink } from '@/lib/openAuthorizationLink'
import { rendererLogger } from '@/lib/log'
import { i18n } from '@/i18n'
import { githubAuthSuccessChannel,githubAuthErrorChannel } from '@/session/shared/events/githubEvents'
import type { LibraryGithubRpc } from '@/session/renderer/features/library/library-host'
import type { LibraryHost } from '@/session/renderer/features/library/library-host'
import { builtinConnectionCatalog } from './builtin-connection-catalog'
import { createConnectionAuthorization, type ConnectionAuthorizationIntent } from './connection-authorization'
import './connection-copy'
import { connectionActionNoticeScope,isQuietConnectionActionFailure,reportConnectionActionFailure } from './connection-action-notice'
import { assertConnectionApplicationAvailable } from './connection-action-guard'
import { connectionClientForRoute,type ConnectionRoute } from '@gugu/core/cloud/connectionRouting'

/** Existing credential services perform the authorization. Only their public
 * result is committed through the separately acquired owner intent. */
export function ownerConnectionActions(base: LibraryHost, host: LibraryHost,deviceId: string | null,route: ConnectionRoute): LibraryHost {
  const bridge = connectionBridge(),store = host.connectionMetadata!
  const client = connectionClientForRoute(bridge.client,bridge.routing,route)
  const assertRoute = () => bridge.routing.assert(route,true)
  const assertApplicationAvailable = (provider: string,requireReady = false,operationIds?: readonly string[]) => {
    const scopeKey = keptOnPlatform(provider) ? 'platform' : deviceId ? `device:${deviceId}` : null
    if (!scopeKey) throw new ConnectionError('device-required','CONNECTION_DEVICE_REQUIRED')
    return assertConnectionApplicationAvailable({ ownerId: store.ownerId,accountId: bridge.accountId,client,provider,scopeKey,
      requireReady,operationIds,changed: () => store.invalidate() })
  }
  const intents = createConnectionAuthorization({ client: { ...client,
    commit: change => {
      if (change.scopeKey === 'platform') return assertApplicationAvailable(String(change.data?.providerId),true,[change.operationId]).then(() => client.commit(change))
      if (!base.integrations.ownerAuthorizationCommit || !change.recreationId || typeof change.data?.providerId !== 'string' || typeof change.data.accountId !== 'string')
        throw new ConnectionError('unsupported-device','CONNECTION_DEVICE_UNSUPPORTED')
      return assertApplicationAvailable(String(change.data?.providerId),true,[change.operationId]).then(() => base.integrations.ownerAuthorizationCommit!({ authorityEpoch: route.epoch,operationId: change.operationId,scopeKey: change.scopeKey,resourceKey: change.resourceKey,
        expectedRevision: change.expectedRevision,recreationId: change.recreationId!,providerId: String(change.data?.providerId),accountId: String(change.data?.accountId) })
      ).then(async receipt => { await assertRoute(); return receipt })
    },
    commitBatch: change => {
      if (!base.integrations.ownerAuthorizationCommitBatch) throw new ConnectionError('unsupported-device','CONNECTION_DEVICE_UNSUPPORTED')
      return assertApplicationAvailable(String(change.operations[0]?.data.providerId),true,change.operations.map(row => row.operationId)).then(() => base.integrations.ownerAuthorizationCommitBatch!({ authorityEpoch: route.epoch,operationId: change.operationId,recreationId: change.recreationId,
        providerId: String(change.operations[0]?.data.providerId),operations: change.operations.map(row => ({ operationId: row.operationId,accountId: String(row.data.accountId) })) })
      ).then(async receipt => { await assertRoute(); return receipt })
    },
  },accountId: bridge.accountId,changed: () => store.invalidate() })
  const cli = new Map<string,ConnectionAuthorizationIntent>()
  const browsers = new Map<string,AbortController>()
  const generations = new Map<string,number>(),intentGenerations = new WeakMap<ConnectionAuthorizationIntent,number>()
  const githubListeners = new Map<string,Set<(value: unknown) => void>>()
  const emitGithub = (name: string,value: unknown) => { for (const listener of githubListeners.get(name) ?? []) listener(value) }
  const onEvent: LibraryGithubRpc['onEvent'] = (event,listener) => {
    if (event.name !== githubAuthSuccessChannel.name && event.name !== githubAuthErrorChannel.name) return host.github.onEvent(event,listener)
    const receive = (value: unknown) => listener(value as never)
    const listeners = githubListeners.get(event.name) ?? new Set<(value: unknown) => void>()
    listeners.add(receive); githubListeners.set(event.name,listeners)
    const stop = event.name === githubAuthErrorChannel.name ? host.github.onEvent(event,listener) : undefined
    return () => { listeners.delete(receive); stop?.() }
  }
  const providerName = (provider: string) => builtinConnectionCatalog(i18n.language).find(app => app.id === provider)?.name ?? provider
  const message = (error: unknown,provider = 'github',failure = 'connectFailed') => ['outcome-unknown','operation-pending'].includes((error as { code?: string } | null)?.code ?? '')
    ? `${providerName(provider)} · ${i18n.t('connections:authorizationUnknown')}`
    : i18n.t((error as { code?: string } | null)?.code === 'device-required' ? 'connections:chooseAppDevice' : `connections:${failure}`,{ name: providerName(provider) })
  function safe<Args extends unknown[],Result>(action: (...args: Args) => Promise<Result>,fixedProvider?: string,failure = 'connectFailed') {
    return async (...args: Args) => {
      const provider = fixedProvider ?? String(args[0]),after = connectionActionNoticeScope()
      const report = (value: unknown,forwarded?: unknown) => {
        if (bridge.accountId() === store.ownerId) reportConnectionActionFailure(value,{ ownerId: store.ownerId,provider,title: message(value,provider,failure),after },forwarded)
      }
      try {
        await assertRoute(); await assertApplicationAvailable(provider)
        const result = await action(...args); await assertRoute()
        if (result && typeof result === 'object' && ('success' in result && result.success === false || 'status' in result && result.status === 'failed')) report(result)
        return result
      } catch (error) {
        const original = error as { code?: string; name?: string; cancelled?: boolean } | null
        const forwarded = Object.assign(new Error(message(error,provider,failure),{ cause: error }),{ code: original?.code,cancelled: original?.name === 'AbortError' || original?.cancelled === true })
        report(error,forwarded)
        if (provider === 'github' && ['outcome-unknown','operation-pending'].includes(forwarded.code ?? ''))
          emitGithub(githubAuthErrorChannel.name,{ error: 'connection_application_busy',message: forwarded.message })
        throw forwarded
      }
    }
  }
  const cancel = (provider: string) => { generations.set(provider,(generations.get(provider) ?? 0)+1) }
  function assertIntent(intent: ConnectionAuthorizationIntent) {
    if (generations.get(intent.providerId) !== intentGenerations.get(intent)) throw new ConnectionError('intent-changed','CONNECTION_AUTHORIZATION_CANCELLED')
  }
  const keptOnPlatform = (provider: string) => builtinConnectionCatalog('en-US').find(row => row.id === provider)?.auth.methods
    .some(method => (method.kind === 'form' || method.kind === 'mcp-oauth') && method.custody === 'platform') ?? false
  async function beginNative(provider: string,accountId: string | null = null) {
    if (!deviceId) throw new ConnectionError('device-required','CONNECTION_DEVICE_REQUIRED')
    cancel(provider)
    const generation = generations.get(provider)
    await host.prepareAssistantAction?.()
    await assertApplicationAvailable(provider)
    if (!base.integrations.ownerAuthorizationBegin || !base.integrations.ownerAccounts || !base.integrations.ownerAuthorizationComplete)
      throw new ConnectionError('unsupported-device','CONNECTION_DEVICE_UNSUPPORTED')
    const operationId = crypto.randomUUID()
    await base.integrations.ownerAuthorizationBegin(provider,operationId,route.epoch)
    await assertRoute()
    if (generations.get(provider) !== generation) throw new ConnectionError('intent-changed','CONNECTION_AUTHORIZATION_CANCELLED')
    const intent = await intents.begin(provider,`device:${deviceId}`,deviceId,accountId,operationId)
    intentGenerations.set(intent,generation!)
    assertIntent(intent)
    return intent
  }
  async function completeNative(intent: ConnectionAuthorizationIntent,accountId: string | undefined) {
    assertIntent(intent)
    if (!accountId) throw new ConnectionError('invalid-response','CONNECTION_AUTHORIZATION_ACCOUNT_MISSING')
    const rows = await base.integrations.ownerAccounts!(intent.providerId)
    const row = rows.find(row => row.accountId === accountId)
    if (!row) throw new ConnectionError('invalid-response','CONNECTION_AUTHORIZATION_ACCOUNT_MISSING')
    const { publicMetadata,...data } = row
    assertIntent(intent)
    await intents.complete(intent,data,publicMetadata)
    assertIntent(intent)
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
      await assertApplicationAvailable(provider,true)
      await rendererPlatformIntegrationsClient().saveCredential(provider,fields,{ connect: 'manual' })
      await completePlatform(intent)
      return { success: true as const }
    }
    const intent = await beginNative(provider,editAccountId ?? null)
    await assertApplicationAvailable(provider,true)
    const result = await base.integrations.connect(provider,credentials,editAccountId,true)
    if (result.success) await completeNative(intent,result.accountId)
    return result
  }
  async function authorize(provider: string) {
    if (!keptOnPlatform(provider)) {
      const intent = await beginNative(provider)
      await assertApplicationAvailable(provider,true)
      const result = await base.integrations.authorize(provider,true)
      if (result.success) await completeNative(intent,result.accountId)
      return result
    }
    browsers.get(provider)?.abort()
    const controller = new AbortController(),signal = controller.signal
    browsers.set(provider,controller)
    const client = rendererPlatformIntegrationsClient()
    const intent = await intents.begin(provider,'platform',null)
    signal.throwIfAborted()
    await assertApplicationAvailable(provider,true)
    const attempt = await client.beginOAuth!(provider,signal)
    try {
      await openAuthorizationLink(attempt.authorizationUrl)
      while (Date.now() < attempt.expiresAt) {
        signal.throwIfAborted()
        await assertRoute()
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
  return { ...host,integrations: { ...host.integrations,connect: safe(connect),authorize: safe(authorize),
    cliToolPrepare: async (provider,signal) => {
      signal?.throwIfAborted()
      await assertRoute(); await assertApplicationAvailable(provider)
      signal?.throwIfAborted()
      return host.integrations.cliToolPrepare(provider,signal)
    },
    cliLoginStart: safe(async (provider: string) => {
      const intent = await beginNative(provider)
      cli.set(provider,intent)
      await assertApplicationAvailable(provider,true)
      const result = await base.integrations.cliLoginStart(provider,true)
      if (result.success && 'connected' in result) { await completeNative(intent,result.accountId); cli.delete(provider) }
      return result
    }),
    cliLoginWait: safe(async (provider: string) => {
      const intent = cli.get(provider)
      if (!intent) throw new ConnectionError('intent-missing','CONNECTION_AUTHORIZATION_EXPIRED')
      const result = await host.integrations.cliLoginWait(provider)
      if (result.status === 'connected') { await completeNative(intent,result.accountId); cli.delete(provider) }
      return result
    }),
    async cancelAuthorization(provider) { cancel(provider); cli.delete(provider); browsers.get(provider)?.abort(); await host.integrations.cancelAuthorization(provider) },
  },github: { ...host.github,onEvent,
    setDefaultAccount: safe(host.github.setDefaultAccount,'github','defaultFailed'),removeAccount: safe(host.github.removeAccount,'github','disconnectFailed'),
    authCancel: async () => { cancel('github'); return host.github.authCancel() },
    importCliAccounts: safe(async () => {
      const intent = await beginNative('github')
      await assertApplicationAvailable('github',true)
      const result = await base.github.importCliAccounts()
      if (result.success && result.importedAccountIds.length) {
        const rows = await base.integrations.ownerAccounts!('github')
        const accounts = result.importedAccountIds.map(id => {
          const row = rows.find(row => row.accountId === id)
          if (!row) throw new ConnectionError('invalid-response','CONNECTION_AUTHORIZATION_ACCOUNT_MISSING')
          const { publicMetadata,...data } = row
          return { data,publicMetadata }
        })
        assertIntent(intent)
        await intents.completeBatch(intent,accounts)
        assertIntent(intent)
        await base.integrations.ownerAuthorizationComplete!('github',intent.operationId)
      }
      return result
    },'github'),
    auth: safe(async () => {
      try {
        const intent = await beginNative('github')
        await assertApplicationAvailable('github',true)
        const result = await base.github.auth(true)
        if (result.success) {
          await completeNative(intent,result.account.accountId)
          if (result.user) emitGithub(githubAuthSuccessChannel.name,{ user: result.user })
        }
        return result
      } catch (error) {
        if (!isQuietConnectionActionFailure(error)) emitGithub(githubAuthErrorChannel.name,{ error: 'connection_commit_failed',message: message(error) })
        throw error
      }
    },'github'),
  } }
}

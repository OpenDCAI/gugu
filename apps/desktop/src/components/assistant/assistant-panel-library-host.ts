import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { LibraryHost, LibraryIntegrationsRpc, LibraryGithubRpc } from '@/session/renderer/features/library/library-host'
import type { GitHubAccountSummary } from '@/session/shared/github'
import { readAssistantPanelIntegrations } from './assistant-panel-integrations'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { waitForAssistantControl } from '@/lib/assistantControlReady'
import { isAssistantActionRefusal } from '@/lib/assistantActionRefusal'
import { rendererLogger } from '@/lib/log'
import { anySignal } from '@gugu/core/shared/anySignal'

const log = rendererLogger('assistant/authorization')

/** Read-only cloud metadata plus explicit existing authorization actions. */
export function assistantPanelLibraryHost(base: LibraryHost, panel: AssistantPanelFiles | undefined, prepare: (signal?: AbortSignal) => Promise<void>,loadError?: unknown): LibraryHost {
  let prepared = false
  const authorizationVersions = new Map<string,number>()
  const pendingPreparations = new Map<string, Set<AbortController>>()
  const cancelPending = (provider: string) => {
    authorizationVersions.set(provider,(authorizationVersions.get(provider) ?? 0) + 1)
    for (const controller of pendingPreparations.get(provider) ?? []) controller.abort()
  }
  const subscriptions = new Set<{ attach(): void; dispose?: () => void }>()
  async function prepareAction(signal?: AbortSignal) {
    signal?.throwIfAborted()
    await requirePanel().assertCurrent()
    signal?.throwIfAborted()
    await prepare(signal)
    signal?.throwIfAborted()
    await requirePanel().assertCurrent()
    if (base.remote) {
      try {
        await waitForAssistantControl(() => base.integrations.checkConfiguredConnections(), () => requirePanel().assertCurrent(), undefined, signal)
      } catch (cause) {
        signal?.throwIfAborted()
        await requirePanel().assertCurrent()
        if (isAssistantActionRefusal(cause)) throw cause
        throw new Error(translateSessionMessage('deviceScope.unreachable', { device: base.remote.deviceLabel }), { cause })
      }
    }
    signal?.throwIfAborted()
    prepared = true
    for (const subscription of subscriptions) subscription.attach()
  }
  async function authorize<T>(provider: string,action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const version = authorizationVersions.get(provider) ?? 0
    const controller = new AbortController()
    const pending = pendingPreparations.get(provider) ?? new Set<AbortController>()
    pending.add(controller); pendingPreparations.set(provider, pending)
    try {
      const active = anySignal([signal, controller.signal])
      await prepareAction(active)
      if ((authorizationVersions.get(provider) ?? 0) !== version) throw new Error(translateSessionMessage('integrations.authorizationCancelled'))
      return await action(active)
    } finally {
      pending.delete(controller)
      if (!pending.size) pendingPreparations.delete(provider)
    }
  }
  const onEvent: LibraryGithubRpc['onEvent'] = (event,listener) => {
    const subscription = { attach() { subscription.dispose ??= base.github.onEvent(event,listener) },dispose: undefined as (() => void) | undefined }
    subscriptions.add(subscription)
    if (prepared) subscription.attach()
    return () => { subscriptions.delete(subscription); subscription.dispose?.() }
  }
  const requirePanel = () => { if (!panel) throw loadError ?? new Error('Assistant account is still loading'); return panel }
  const read = (locale = 'en-US') => readAssistantPanelIntegrations(requirePanel(),locale)
  async function accounts(provider: string) {
    return (await requirePanel().collection('integrations')).filter(row => row.data.providerId === provider && typeof row.data.accountId === 'string')
  }
  async function disconnect(provider: string, accountId?: string) {
    for (const row of await accounts(provider)) if (!accountId || row.data.accountId === accountId) await requirePanel().change(row,'remove')
    return { success: true as const }
  }
  const integrations: LibraryIntegrationsRpc = {
    list: async locale => (await read(locale)).items,
    checkConfiguredConnections: async () => (await read()).configured,
    checkAllConnections: async () => (await read()).statuses,
    accounts: async provider => Promise.all((await accounts(provider)).map(async row => {
      const data = JSON.parse(new TextDecoder().decode(await requirePanel().body(row)))
      if (typeof data.connectedAt !== 'number') throw new Error('Saved account metadata is unavailable')
      return { accountId: String(row.data.accountId),displayName: String(row.data.displayName ?? ''),connectedAt: data.connectedAt,isDefault: row.data.isDefault === true,fields: {} }
    })),
    checkAccounts: async provider => {
      const state = await read()
      return state.accounts.filter(row => row.data.providerId === provider && state.accountChecks.has(row.resource_key)).map(row => ({ accountId: String(row.data.accountId),
        connected: state.accountChecks.get(row.resource_key)! }))
    },
    disconnect,
    connect: (...args) => authorize(args[0],() => base.integrations.connect(...args)),
    authorize: (...args) => authorize(args[0],() => base.integrations.authorize(...args)),
    cliLoginStart: (...args) => authorize(args[0],() => base.integrations.cliLoginStart(...args)),
    // 第一问叫醒 / 核对那台(云电脑停着就先唤醒,叫不醒明说);之后每 20 秒一问不再重复唤醒。
    cliToolPrepare: async (provider, signal) => {
      try {
        signal?.throwIfAborted()
        return await (prepared ? base.integrations.cliToolPrepare(provider) : authorize(provider,() => base.integrations.cliToolPrepare(provider), signal))
      } catch (error) {
        // The previous successful preparation says nothing about this live
        // connection. A retry must wake/check the home again after a failure.
        prepared = false
        throw error
      }
    },
    cliLoginWait: async (provider) => {
      const version = authorizationVersions.get(provider) ?? 0
      await requirePanel().assertCurrent()
      try { return await base.integrations.cliLoginWait(provider) }
      catch (error) {
        log.warn({ provider, code: (error as { code?: string } | null)?.code, refused: isAssistantActionRefusal(error) }, 'authorization status disconnected')
        if (!base.remote || isAssistantActionRefusal(error)) throw error
        // A known sleeping host can be rejected before its pipe opener runs.
        // This is an active authorization's idempotent status read: resume it
        // through preparation, then read the same operation once more.
        prepared = false
        await requirePanel().assertCurrent()
        if ((authorizationVersions.get(provider) ?? 0) !== version) throw new Error(translateSessionMessage('integrations.authorizationCancelled'))
        const deviceLabel = base.remote.deviceLabel
        return authorize(provider, async signal => {
          let result: Awaited<ReturnType<LibraryIntegrationsRpc['cliLoginWait']>> | undefined
          // Resume can hand the connection from realtime back to its SSH tunnel.
          // A read in that handoff is safe to retry within the same deadline.
          try {
            await waitForAssistantControl(async () => { result = await base.integrations.cliLoginWait(provider) }, async () => {
              await requirePanel().assertCurrent()
              if ((authorizationVersions.get(provider) ?? 0) !== version) throw new Error(translateSessionMessage('integrations.authorizationCancelled'))
            }, 90_000, signal)
          } catch (cause) {
            signal.throwIfAborted()
            if (isAssistantActionRefusal(cause)) throw cause
            throw new Error(translateSessionMessage('deviceScope.unreachable', { device: deviceLabel }), { cause })
          }
          log.info({ provider, status: result!.status }, 'authorization status resumed')
          return result!
        })
      }
    },
    cliLoginProgress: (...args) => prepared ? base.integrations.cliLoginProgress(...args) : Promise.resolve(null),
    cancelAuthorization: (...args) => { cancelPending(args[0]); return prepared ? base.integrations.cancelAuthorization(...args) : Promise.resolve() },
  }
  async function githubAccounts(): Promise<GitHubAccountSummary[]> {
    const rows = await accounts('github')
    const requested = rows.filter(row => row.data.isDefault === true).sort((a,b) => BigInt(a.revision) > BigInt(b.revision) ? -1 : 1)[0]
    return Promise.all(rows.map(async row => {
      const data = JSON.parse(new TextDecoder().decode(await requirePanel().body(row)))
      if (typeof data.host !== 'string' || typeof data.login !== 'string') throw new Error('Saved GitHub account metadata is unavailable')
      return { accountId: String(row.data.accountId),host: data.host,login: data.login,avatarUrl: typeof data.avatarUrl === 'string' ? data.avatarUrl : '',
        credentialSource: data.credentialSource === 'cli' ? 'cli' : data.credentialSource === 'device_flow' ? 'device_flow'
          : data.credentialSource === 'oauth' ? 'emdash_oauth' : 'secure_storage',
        isDefault: row.resource_key === requested?.resource_key,
      }
    }))
  }
  return { ...base,key: panel ? `assistant-panel:${panel.ownerId}:${panel.assistantId}` : 'assistant-panel:loading',
    assistantPanel: panel,assistantPanelExpected: true,assistantPanelError: loadError,prepareAssistantAction: prepareAction,integrations,
    github: {
      listAccounts: githubAccounts,
      async removeAccount(accountId) { await disconnect('github',accountId); return { success: true,accounts: await githubAccounts() } },
      async setDefaultAccount(accountId) {
        const row = (await accounts('github')).find(row => row.data.accountId === accountId)
        if (!row) return { success: false,error: 'The account no longer exists' }
        await requirePanel().save(row,{ ...row.data,isDefault: true })
        const account = (await githubAccounts()).find(row => row.accountId === accountId)!
        return { success: true,account }
      },
      importCliAccounts: () => authorize('github',() => base.github.importCliAccounts()),
      auth: () => authorize('github',() => base.github.auth()),
      authCancel: () => { cancelPending('github'); return prepared ? base.github.authCancel() : Promise.resolve({ success: true as const }) },
      onEvent,
    },
  }
}

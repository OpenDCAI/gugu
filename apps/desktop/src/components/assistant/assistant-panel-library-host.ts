import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { LibraryHost, LibraryIntegrationsRpc, LibraryGithubRpc } from '@/session/renderer/features/library/library-host'
import type { GitHubAccountSummary } from '@/session/shared/github'
import { readAssistantPanelIntegrations } from './assistant-panel-integrations'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { waitForAssistantControl } from '@/lib/assistantControlReady'

/** Read-only cloud metadata plus explicit existing authorization actions. */
export function assistantPanelLibraryHost(base: LibraryHost, panel: AssistantPanelFiles | undefined, prepare: () => Promise<void>,loadError?: unknown): LibraryHost {
  let prepared = false
  const authorizationVersions = new Map<string,number>()
  const cancelPending = (provider: string) => authorizationVersions.set(provider,(authorizationVersions.get(provider) ?? 0) + 1)
  const subscriptions = new Set<{ attach(): void; dispose?: () => void }>()
  async function prepareAction() {
    await requirePanel().assertCurrent()
    await prepare()
    await requirePanel().assertCurrent()
    if (base.remote) {
      try {
        await waitForAssistantControl(() => base.integrations.checkConfiguredConnections(), () => requirePanel().assertCurrent())
      } catch (cause) {
        await requirePanel().assertCurrent()
        throw new Error(translateSessionMessage('deviceScope.unreachable', { device: base.remote.deviceLabel }), { cause })
      }
    }
    prepared = true
    for (const subscription of subscriptions) subscription.attach()
  }
  async function authorize<T>(provider: string,action: () => Promise<T>): Promise<T> {
    const version = authorizationVersions.get(provider) ?? 0
    await prepareAction()
    if ((authorizationVersions.get(provider) ?? 0) !== version) throw new Error(translateSessionMessage('integrations.authorizationCancelled'))
    return action()
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
    cliLoginWait: (...args) => base.integrations.cliLoginWait(...args),
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

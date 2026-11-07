import { ConnectionError,type ConnectionClient } from '@gugu/core/cloud/connections'
import type { PlatformIntegrationsClient } from '@gugu/core/cloud/platformIntegrations'
import type { IntegrationCredentials } from '@gugu/session-plugins/integrations'
import type { LibraryIntegrationsRpc } from '@/session/renderer/features/library/library-host'
import { createConnectionAuthorization } from './connection-authorization'
import type { ConnectionVerificationStore,ConnectionPreviousPresentation } from './connection-verification'

type Attempt = { id: string; provider: string; platform: boolean; abort: AbortController; submitted: boolean; held: boolean;
  setup: Promise<void>; setupDone(): void; releasing?: Promise<void> }
const cancelled = () => Object.assign(new Error('CONNECTION_AUTHORIZATION_CANCELLED'),{ name: 'AbortError',cancelled: true })
function abortable<T>(promise: Promise<T>,signal: AbortSignal): Promise<T> {
  return new Promise((resolve,reject) => {
    const abort = () => reject(cancelled())
    if (signal.aborted) abort(); else signal.addEventListener('abort',abort,{ once: true })
    promise.then(resolve,reject).finally(() => signal.removeEventListener('abort',abort))
  })
}
const pause = (signal: AbortSignal,delay: number) => new Promise<void>((resolve,reject) => {
  if (signal.aborted) { reject(cancelled()); return }
  const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve() },delay)
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort',abort); reject(cancelled()) }
  signal.addEventListener('abort',abort,{ once: true })
})

/** The managed producer owns credentials and frozen publication bytes. The
 * consumer persists only public identity before contacting that producer. */
export function createManagedConnectionAuthorization(input: {
  ownerId: string; epoch: string; deviceId: string | null; accountId(): string | null
  client: ConnectionClient; ledger?: ConnectionVerificationStore; native: LibraryIntegrationsRpc
  platform(): PlatformIntegrationsClient; onPlatform(provider: string): boolean; supported(provider: string): boolean
  assertCurrent(mutation?: boolean): Promise<void>; available(provider: string,id?: string): Promise<void>
  prepareNative?(): Promise<unknown>; openLink(url: string): Promise<unknown>; changed(): void; failed(error: unknown): void
}) {
  const active = new Map<string,Attempt>(),previous = new Map<string,ConnectionPreviousPresentation>()
  function current() { if (input.accountId() !== input.ownerId) throw new ConnectionError('account-changed','CONNECTION_ACCOUNT_CHANGED') }
  function canAuthorize(provider: string,kind?: 'connect' | 'authorize') {
    if (!input.ledger || !input.supported(provider)) return false
    if (input.onPlatform(provider)) {
      try {
        const platform = input.platform()
        return !!platform.cancelOperation && (!kind || kind === 'connect' ? !!platform.connectOperation : !!platform.beginOAuthOperation)
      } catch (error) {
        if ((error as { code?: string } | null)?.code === 'platform-unavailable') return false
        throw error
      }
    }
    return !!input.deviceId && !!input.native.ownerAuthorizationBegin && !!input.native.ownerAuthorizationPrepare
      && !!input.native.ownerAuthorizationComplete && !!input.native.ownerAuthorizationCommit
      && (kind === 'authorize' ? !!input.native.ownerAuthorize : kind === 'connect' ? !!input.native.ownerConnect : !!input.native.ownerConnect || !!input.native.ownerAuthorize)
  }
  async function requestCancellation(attempt: Pick<Attempt,'id' | 'platform'>) {
    current(); await input.assertCurrent()
    const result = attempt.platform ? await input.platform().cancelOperation!(attempt.id) : await input.client.cancelAuthorization(attempt.id)
    current(); await input.assertCurrent()
    // NULL/404 is never proof that a delayed recreation/prepare cannot arrive.
    if (result !== null) input.ledger!.accept(attempt.id,result)
  }
  async function release(attempt: Attempt) {
    if (!attempt.held) return
    current()
    attempt.releasing ??= input.native.ownerAuthorizationComplete!(attempt.provider,attempt.id).catch(error => { attempt.releasing = undefined; throw error })
    await attempt.releasing
  }
  async function waitForOutcome(attempt: Attempt) {
    let failures = 0
    while (!attempt.abort.signal.aborted) {
      attempt.abort.signal.throwIfAborted(); current(); await input.assertCurrent()
      let state: 'confirming' | 'succeeded' | 'failed' | 'cancelled' = 'confirming'
      try {
        const result = await input.client.operationStatus(attempt.id)
        current(); await input.assertCurrent(); attempt.abort.signal.throwIfAborted()
        if (result !== null) { input.ledger!.accept(attempt.id,result); state = result.effective.state }
        failures = 0
      } catch (error) {
        current(); attempt.abort.signal.throwIfAborted(); await input.assertCurrent()
        input.failed(error); failures++
      }
      if (state === 'succeeded') return { success: true as const }
      if (state === 'cancelled') throw cancelled()
      if (state === 'failed') throw new ConnectionError('authorization-failed','CONNECTION_AUTHORIZATION_FAILED')
      await pause(attempt.abort.signal,Math.min(30_000,1000 * 2 ** Math.min(failures,5)))
    }
    throw cancelled()
  }
  function run(provider: string,kind: 'connect' | 'authorize',credentials?: IntegrationCredentials,accountId?: string) {
    if (!canAuthorize(provider,kind)) throw new ConnectionError('unsupported-device','CONNECTION_MANAGED_AUTHORIZATION_UNAVAILABLE')
    current()
    if (active.has(provider)) throw new ConnectionError('operation-pending','CONNECTION_APPLICATION_BUSY')
    const platform = input.onPlatform(provider),id = crypto.randomUUID(),abort = new AbortController()
    let setupDone!: () => void
    const setup = new Promise<void>(resolve => { setupDone = resolve })
    const attempt: Attempt = { id,provider,platform,abort,submitted: false,held: false,setup,setupDone }
    active.set(provider,attempt)
    async function check() { current(); abort.signal.throwIfAborted(); await input.assertCurrent(true); abort.signal.throwIfAborted() }
    async function execute() {
      let recorded = false
      try {
        await check(); await input.available(provider); await check()
        input.ledger!.begin({ operationId: id,providerId: provider,scopeKey: platform ? 'platform' : `device:${input.deviceId}`,
          deviceId: platform ? null : input.deviceId,resourceKey: null,operation: 'save',...(previous.has(provider) ? { previous: previous.get(provider)! } : {}) })
        recorded = true; previous.delete(provider)
        if (!platform) {
          await input.prepareNative?.(); await check()
          attempt.held = true
          await input.native.ownerAuthorizationBegin!(provider,id,input.epoch); await check()
        }
        const intents = createConnectionAuthorization({ client: { ...input.client,recreateBegin: value => {
          current(); abort.signal.throwIfAborted()
          input.ledger!.markSubmitted(id); attempt.submitted = true
          return input.client.recreateBegin(value)
        } },accountId: input.accountId,changed: input.changed })
        const intent = await intents.begin(provider,platform ? 'platform' : `device:${input.deviceId}`,platform ? null : input.deviceId,accountId ?? null,id)
        input.ledger!.bind(id,intent.resourceKey); await check()
        if (!platform) { await input.native.ownerAuthorizationPrepare!(provider,id,input.epoch); await check() }
        attempt.setupDone()
        await input.available(provider,id); await check()
        try {
          if (platform) {
            if (kind === 'authorize') {
              const started = await input.platform().beginOAuthOperation!(provider,id,input.epoch)
              await check(); await input.openLink(started.authorizationUrl)
            } else {
              const fields = Object.fromEntries(Object.entries(credentials!).filter((entry): entry is [string,string] => typeof entry[1] === 'string'))
              const result = await input.platform().connectOperation!(provider,id,input.epoch,fields)
              current()
              if ('resourceKey' in result) input.ledger!.bind(id,result.resourceKey)
            }
          } else {
            const result = kind === 'connect' ? await input.native.ownerConnect!(provider,id,input.epoch,credentials!,accountId)
              : await input.native.ownerAuthorize!(provider,id,input.epoch)
            await check()
            if (result.success && result.accountId) {
              await input.available(provider,id); await check()
              const receipt = await input.native.ownerAuthorizationCommit!({ authorityEpoch: input.epoch,operationId: id,scopeKey: intent.scopeKey,
                resourceKey: intent.resourceKey,expectedRevision: intent.expectedRevision,recreationId: intent.recreationId,providerId: provider,accountId: result.accountId })
              if (receipt.operationId !== id || receipt.scopeKey !== intent.scopeKey) throw new ConnectionError('invalid-response','CONNECTION_OPERATION_MISMATCH')
              current(); input.ledger!.bind(id,receipt.resourceKey)
            }
          }
        } catch (error) {
          if ((error as { name?: string; cancelled?: boolean } | null)?.name === 'AbortError'
            || (error as { cancelled?: boolean } | null)?.cancelled === true) {
            void cancel(provider).catch(input.failed)
            throw cancelled()
          }
          await check()
          // Lost producer/commit replies are observed by original UUID. No
          // credential call, request body or ticket is reconstructed/replayed.
          input.failed(error)
        }
        return await waitForOutcome(attempt)
      } catch (error) {
        if (recorded && !attempt.submitted) input.ledger!.discardUnsubmitted(id)
        if (abort.signal.aborted) throw cancelled()
        throw error
      } finally {
        attempt.setupDone()
        await release(attempt).catch(input.failed)
        if (active.get(provider) === attempt) active.delete(provider)
        input.changed()
      }
    }
    return abortable(execute(),abort.signal)
  }
  async function cancel(provider: string) {
      current()
      const attempt = active.get(provider)
      if (attempt) attempt.abort.abort(cancelled())
      for (const row of input.ledger?.list() ?? []) {
        if (row.providerId !== provider || row.scopeKey !== (input.onPlatform(provider) ? 'platform' : `device:${input.deviceId}`)
          || row.status?.effective.blocksNewOperations === false) continue
        input.ledger!.requestCancellation(row.operationId)
        if (row.submitted) await requestCancellation({ id: row.operationId,platform: row.scopeKey === 'platform' }).catch(input.failed)
      }
      if (attempt) {
        await attempt.setup
        const row = input.ledger?.read(attempt.id)
        if (row?.submitted && !row.status?.confirmation.cancelRequested && row.status?.effective.blocksNewOperations !== false)
          await requestCancellation(attempt).catch(input.failed)
        await release(attempt).catch(input.failed)
      }
  }
  return {
    canAuthorize,
    opened(provider: string,state: ConnectionPreviousPresentation) { previous.set(provider,{ ...state }) },
    connect: (provider: string,credentials: IntegrationCredentials,accountId?: string) => run(provider,'connect',credentials,accountId),
    authorize: (provider: string) => run(provider,'authorize'),cancel,
  }
}

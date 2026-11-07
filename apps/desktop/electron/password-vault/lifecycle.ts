import type { LocalPasswordVault } from './service'
import type { VaultCode } from './contracts'

interface PowerEvents {
  on(event: 'lock-screen' | 'suspend', listener: () => void): unknown
  removeListener(event: 'lock-screen' | 'suspend', listener: () => void): unknown
}
interface AppEvents {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  removeListener(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}
/** Install once in the trusted host when the full feature is integrated. No unlock on resume. */
export function installVaultLifecycle(vault: LocalPasswordVault, power: PowerEvents, app: AppEvents, attention: (code: VaultCode) => void) {
  const report = (promise: Promise<void>) => { void promise.catch(() => attention('AUDIT_FAILED')) }
  const onLock = () => report(vault.lock('os-lock'))
  const onSuspend = () => report(vault.lock('suspend'))
  let quitting = false
  const onQuit = (event: { preventDefault(): void }) => {
    if (quitting) return
    quitting = true; event.preventDefault()
    void vault.dispose().catch(() => attention('AUDIT_FAILED')).finally(() => app.quit())
  }
  power.on('lock-screen', onLock); power.on('suspend', onSuspend); app.on('before-quit', onQuit)
  return {
    /** Await before exposing another account; this object cannot be reused for a new owner. */
    async accountChanged() { await vault.lock('account-switch'); await vault.dispose() },
    async logout() { await vault.lock('logout'); await vault.dispose() },
    remove() { power.removeListener('lock-screen', onLock); power.removeListener('suspend', onSuspend); app.removeListener('before-quit', onQuit) },
  }
}

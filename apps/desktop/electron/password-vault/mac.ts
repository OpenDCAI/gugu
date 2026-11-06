import { app, safeStorage, systemPreferences } from 'electron'
import { timingSafeEqual } from 'node:crypto'
import { VaultError, type VaultKeyProtector } from './contracts'
import { decode } from './crypto'

/** Import only in the real desktop main. Headless/server shims must never supply vault keys. */
export function macVaultKeyProtector(): VaultKeyProtector {
  function available(): void {
    if (process.platform !== 'darwin' || process.type !== 'browser' || !app.isReady() || !safeStorage.isEncryptionAvailable()) throw new VaultError('UNAVAILABLE')
  }
  return {
    async verifyPerson() {
      available()
      if (!systemPreferences.canPromptTouchID()) throw new VaultError('UNAVAILABLE')
      try { await systemPreferences.promptTouchID('解锁咕咕本机密码保险箱') }
      catch { throw new VaultError('CANNOT_UNLOCK') }
    },
    async wrap(key, binding) {
      available()
      try { return safeStorage.encryptString(JSON.stringify({ binding, key: key.toString('base64') })).toString('base64') }
      catch { throw new VaultError('CANNOT_UNLOCK') }
    },
    async unwrap(wrapped, binding) {
      available()
      try {
        const value = JSON.parse(safeStorage.decryptString(decode(wrapped))) as { binding: string; key: string }
        const expected = Buffer.from(binding), actual = Buffer.from(value.binding)
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error()
        const key = decode(value.key)
        if (key.length !== 32) { key.fill(0); throw new Error() }
        return key
      } catch { throw new VaultError('CANNOT_UNLOCK') }
    },
  }
}

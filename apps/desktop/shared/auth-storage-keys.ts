export const MAIN_AUTH_STORAGE_KEY = 'sb-main'
export const MAIN_PKCE_STORAGE_KEY = `${MAIN_AUTH_STORAGE_KEY}-code-verifier`
export const OAUTH_PENDING_STORAGE_KEY = `${MAIN_AUTH_STORAGE_KEY}-oauth-pending`

export function isAuthTemporaryStorageKey(key: string): boolean {
  return key === MAIN_PKCE_STORAGE_KEY || key === OAUTH_PENDING_STORAGE_KEY
}

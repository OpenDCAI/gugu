/**
 * @@@app-forget (L9, 摩擦单 F67) — The phone's page in an App's origin that forgets what the App kept there:
 * uninstalling an App from the phone takes its browser storage with it, as uninstalling on the desktop clears the App's
 * partition. Android WebView cannot clear one origin's storage from Java — `WebStorage.deleteOrigin` leaves
 * localStorage and CacheStorage (measured on l9_a: an App reinstalled read its old localStorage) — so the forgetting
 * runs where the storage is: this page, which the shell serves under the App's origin at `/_gugu/<ver>/`,
 * from this build, never from the App's package (a package cannot ship `_gugu/`, bundleEntryRejection).
 *
 * It clears, then tells the gugu page it is done (phoneApps.ts `uninstall`). It reads nothing out and sends nothing
 * anywhere else. Cookies go by name at the paths this page sees (`/` and its own); the App's pages set theirs from
 * `/` — a cookie an App scoped to a deeper path of its own is not visible here and stays with the origin.
 */

async function forget(): Promise<void> {
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    // No storage to clear.
  }
  try {
    for (const database of await indexedDB.databases()) {
      const name = database.name
      if (!name) continue
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name)
        request.onsuccess = request.onerror = request.onblocked = () => resolve()
      })
    }
  } catch {
    // No IndexedDB here.
  }
  try {
    for (const key of await caches.keys()) await caches.delete(key)
  } catch {
    // No CacheStorage here.
  }
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0]?.trim()
    if (name) document.cookie = `${name}=; Max-Age=0; path=/; Secure; SameSite=None`
  }
}

void forget().finally(() => parent.postMessage({ gugu: 'forgotten' }, '*'))

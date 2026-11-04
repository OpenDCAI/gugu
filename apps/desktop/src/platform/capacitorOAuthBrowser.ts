import { Browser } from '@capacitor/browser'

/** Keep provider authorization in the system browser, outside the app's WebView. */
export async function openBrowser(url: string): Promise<void> {
  let target: URL
  try { target = new URL(url) } catch { throw new Error('Invalid authorization URL') }
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Invalid authorization URL')
  await Browser.open({ url: target.href })
}

/** Await native registration before opening authorization. A native finished event is not proof
 * of cancellation; the shared auth flow gives received authorization callbacks priority. */
export async function subscribeBrowserFinished(listener: () => void, onError: (error: unknown) => void): Promise<() => void> {
  let active = true
  const handle = await Browser.addListener('browserFinished', () => {
    if (!active) return
    try { listener() } catch (error) { onError(error) }
  })
  return () => {
    if (!active) return
    active = false
    // Stop delivery immediately, even while native removal is pending or fails.
    void Promise.resolve().then(() => handle.remove()).catch(onError)
  }
}

import type { Page } from '@playwright/test'

// The renderer's Supabase session key. Writing it into the app document's localStorage and reloading
// is how every harness path logs an owner in without driving the OTP form.
export const SB_KEY = 'sb-main'

export const isMainAppPageUrl = (url: string): boolean =>
  (/^(?:https?|gugu-app):\/\//.test(url) || url.startsWith('file:')) && !/\/widget/i.test(url)

/** Every stop this gate can halt at gets its own name, so a failure reads as itself. */
export const SESSION_INJECTION_ERROR = {
  noAppDocument: '[session-injection] the app document never appeared',
  writeRefused: '[session-injection] localStorage never accepted the session write',
  lostOnReload: '[session-injection] the session did not survive the reload',
} as const

export type SessionInjectionBudget = {
  appDocumentMs?: number
  writeMs?: number
  readbackMs?: number
}

const originOf = (page: Page): string => {
  try { return new URL(page.url()).origin } catch { return page.url() }
}

// @@@poll-on-a-timer - waitForFunction's DEFAULT polling is requestAnimationFrame (playwright-core
// frames.js: `if (typeof polling !== 'number') requestAnimationFrame(next)`). The predicate runs once
// synchronously and is then re-armed ONLY by a frame. A harness window that is hidden, fully occluded
// or background-throttled produces no frames, so a predicate that is false on the first tick can never
// become true again — the gate burns its whole budget no matter what the document does. This module's
// job is to retry until the document settles, which must not be coupled to the window being composited.
const POLL_MS = 250

/**
 * Land `sessionValue` in the app document and PROVE it is still there after the reload.
 *
 * The order matters and every step is fail-loud. The app document must be reached BEFORE the write,
 * because the document decides which origin the write lands on: localStorage is per-origin, so a write
 * performed while the window still sits on `about:blank` (opaque origin → access denied) or on some
 * other document either throws or lands somewhere the app will never read. Swallowing that wait lets
 * the write "succeed" against the wrong origin, and the app then boots logged OUT — surfacing much
 * later as an unrelated selector timeout that reads like the product failed to render.
 */
export async function injectSessionAndReload(
  page: Page,
  sessionValue: string,
  budget: SessionInjectionBudget = {},
): Promise<void> {
  const appDocumentMs = budget.appDocumentMs ?? 45_000
  const writeMs = budget.writeMs ?? 30_000
  const readbackMs = budget.readbackMs ?? 30_000

  // 1. Reach the app document — this fixes the origin the session is about to be written to.
  try {
    await page.waitForURL((u) => isMainAppPageUrl(u.toString()), { timeout: appDocumentMs })
    await page.waitForLoadState('domcontentloaded')
  } catch (cause) {
    throw new Error(`${SESSION_INJECTION_ERROR.noAppDocument} within ${appDocumentMs}ms; last URL=${page.url()}`, { cause })
  }

  // 2. Write it and read it straight back. The document can still flip to an opaque origin between the
  // gate above and here (a reload, or a transient blank under load), where a bare setItem throws
  // "Access is denied" — so retry until localStorage both accepts the value AND returns it.
  try {
    await page.waitForFunction(
      ({ k, v }) => { try { window.localStorage.setItem(k, v); return window.localStorage.getItem(k) === v } catch { return false } },
      { k: SB_KEY, v: sessionValue },
      { timeout: writeMs, polling: POLL_MS },
    )
  } catch (cause) {
    throw new Error(`${SESSION_INJECTION_ERROR.writeRefused} within ${writeMs}ms at origin=${originOf(page)}`, { cause })
  }

  // 3. Reload so the renderer boots against the injected session. This evaluate is expected to reject:
  // the navigation tears down the very execution context that would deliver its reply. That is the one
  // swallow on this path that is genuinely correct — do NOT "fix" it into a fail-loud await.
  await page.evaluate(() => window.location.reload()).catch(() => {})

  // 4. The postcondition. "The write returned true" only says the value reached SOME origin at SOME
  // moment; it does not say the app boots with a session. Read it back on the reloaded app document,
  // so a session that never landed fails HERE, named, instead of as a downstream selector timeout.
  try {
    await page.waitForURL((u) => isMainAppPageUrl(u.toString()), { timeout: readbackMs })
    await page.waitForFunction(
      ({ k, v }) => { try { return window.localStorage.getItem(k) === v } catch { return false } },
      { k: SB_KEY, v: sessionValue },
      { timeout: readbackMs, polling: POLL_MS },
    )
  } catch (cause) {
    throw new Error(
      `${SESSION_INJECTION_ERROR.lostOnReload} within ${readbackMs}ms at origin=${originOf(page)};`
      + ' the renderer will boot logged out',
      { cause },
    )
  }
}

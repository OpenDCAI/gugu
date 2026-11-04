import { test, expect, type Page } from '@playwright/test'
import {
  SB_KEY,
  SESSION_INJECTION_ERROR,
  injectSessionAndReload,
} from '../../support/session-injection'

// #3592. The harness logs every owner in by writing `sb-main` into the app document and reloading.
// That gate used to be three swallowed waits followed by an unverified write, so a session that never
// landed produced NO signal here — it surfaced much later as an unrelated selector timeout, which reads
// like the product failed to render. These cases pin the gate's own verdict instead: it must report
// success only when the session is genuinely readable back off the reloaded app document, and each way
// it can fail must go red naming THAT step.
//
// Everything is served by route interception, so this owns its documents outright: no dev server, no
// database, no Electron. The unit under test is the real shipped primitive, driven through a real
// browser — not a re-implementation and not a fake page.

const SESSION = 'session-value-3592'
const APP_ORIGIN = 'https://app.gugu-3592.test'
const APP_URL = `${APP_ORIGIN}/index.html`
// isMainAppPageUrl rejects any URL containing /widget — a document the harness must never log into.
const NON_APP_URL = `${APP_ORIGIN}/widget/panel.html`

const BODY = '<!doctype html><title>gugu-3592</title><p id="ready">app</p>'

/** Serve a fixed body for every request, optionally running a script on each load. */
async function serveApp(page: Page, onLoadScript = ''): Promise<void> {
  await page.route('**/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: onLoadScript ? `${BODY}<script>${onLoadScript}</script>` : BODY,
    }))
}

const readSession = (page: Page): Promise<string | null> =>
  page.evaluate((k) => { try { return window.localStorage.getItem(k) } catch { return null } }, SB_KEY)

test.describe('harness login session injection (#3592)', () => {
  test('lands the session and proves it survived the reload', async ({ page }) => {
    await serveApp(page)
    await page.goto(APP_URL)

    await injectSessionAndReload(page, SESSION, { appDocumentMs: 5_000, writeMs: 5_000, readbackMs: 5_000 })

    // The positive claim: not "it did not throw" but "the session is genuinely readable, on the app
    // document, after the reload" — and the first product-shaped read against that document works.
    expect(await readSession(page), 'the injected session is readable back on the reloaded app document').toBe(SESSION)
    expect(page.url(), 'the reloaded document is still the app document').toBe(APP_URL)
    await expect(page.locator('#ready'), 'the reloaded app document is interactive').toBeVisible()
  })

  // ── must-fail conditions ───────────────────────────────────────────────────────────────────────
  // A criterion that has never been shown to go red is not a criterion. Each case below breaks exactly
  // one thing and requires the gate to name that thing; the assertions are on the STEP identity, so a
  // gate that fails for some other reason does not count as passing these.

  test('goes red on the document gate when the app document is never reached', async ({ page }) => {
    await serveApp(page)
    await page.goto(NON_APP_URL) // a /widget document — never a login target

    const failure = await injectSessionAndReload(page, SESSION, { appDocumentMs: 1_500, writeMs: 1_500, readbackMs: 1_500 })
      .then(() => null, (error: Error) => error)

    expect(failure, 'the gate must not report success from a non-app document').not.toBeNull()
    expect(failure?.message).toContain(SESSION_INJECTION_ERROR.noAppDocument)
    // Non-target steps must stay green, or the case moved more than one variable.
    expect(failure?.message).not.toContain(SESSION_INJECTION_ERROR.writeRefused)
    expect(failure?.message).not.toContain(SESSION_INJECTION_ERROR.lostOnReload)
  })

  test('goes red on the write gate when localStorage never accepts the value', async ({ page }) => {
    // setItem silently does nothing: the write "succeeds" but never sticks. This is the shape a bare
    // setItem + no readback would have sailed straight past.
    await serveApp(page, 'window.localStorage.setItem = function () {}')
    await page.goto(APP_URL)

    const failure = await injectSessionAndReload(page, SESSION, { appDocumentMs: 5_000, writeMs: 1_500, readbackMs: 1_500 })
      .then(() => null, (error: Error) => error)

    expect(failure, 'a write that never sticks must not report success').not.toBeNull()
    expect(failure?.message).toContain(SESSION_INJECTION_ERROR.writeRefused)
    expect(failure?.message).not.toContain(SESSION_INJECTION_ERROR.noAppDocument)
    expect(failure?.message).not.toContain(SESSION_INJECTION_ERROR.lostOnReload)
  })

  test('goes red on LOGIN, not on a downstream selector, when the session is lost across the reload', async ({ page }) => {
    // The write lands and reads back — then the reloaded document boots without it. This is the exact
    // silent case #3592 is about: every earlier step reports success and the app comes up logged OUT.
    // Before this gate existed the run continued and died at some later product locator.
    await serveApp(page, `if (!sessionStorage.getItem('first-load')) { sessionStorage.setItem('first-load', '1') } else { localStorage.removeItem(${JSON.stringify(SB_KEY)}) }`)
    await page.goto(APP_URL)

    const failure = await injectSessionAndReload(page, SESSION, { appDocumentMs: 5_000, writeMs: 5_000, readbackMs: 1_500 })
      .then(() => null, (error: Error) => error)

    expect(failure, 'a session that does not survive the reload must not report success').not.toBeNull()
    expect(failure?.message).toContain(SESSION_INJECTION_ERROR.lostOnReload)
    // The whole point: the failure is attributed to login, not to the document or the write, and
    // certainly not to a product selector further down the run.
    expect(failure?.message).not.toContain(SESSION_INJECTION_ERROR.noAppDocument)
    expect(failure?.message).not.toContain(SESSION_INJECTION_ERROR.writeRefused)

    // Positive control for the mutation itself: the session really is gone. Without this, a red here
    // would be indistinguishable from a gate that simply always fails.
    expect(await readSession(page), 'the mutation genuinely removed the session').toBeNull()
  })
})

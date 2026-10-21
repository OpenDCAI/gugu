import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => /index/i.test(p.url()))
if (!page) { console.log('NO PAGE'); process.exit(1) }

// Check various hooks/globals
const checks = await page.evaluate(() => ({
  __guguSimulateStaleSubscription: typeof globalThis.__guguSimulateStaleSubscription,
  _simulateStale: typeof globalThis._simulateStale,
  hasSessionAttached: typeof globalThis.sessionAttached,
  // check if import.meta.env.DEV was even compiled in (production build strips it)
  appVersion: document.title,
}))
console.log('=== build capability check ===')
console.log(JSON.stringify(checks, null, 1))

// Also check the running avatar color code (the orange/neutral question)
const colorCheck = await page.evaluate(() => {
  // Find any running/idle badge and its computed color
  const dots = [...document.querySelectorAll('.av-status__dot')]
  return dots.slice(0, 8).map(d => {
    const s = getComputedStyle(d)
    const parent = d.closest('.av-status')
    return {
      cls: parent?.className,
      bg: s.backgroundColor,
      border: s.borderColor,
    }
  })
})
console.log('=== badge colors on screen ===')
console.log(JSON.stringify(colorCheck, null, 1))
await browser.close()

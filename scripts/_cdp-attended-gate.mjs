import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => /index/i.test(p.url()))
if (!page) { console.log('NO PAGE'); process.exit(1) }

// Check sessionAttached state (how many clients on the tmux session)
// This is informational — the gate runs host-side, not renderer-side.
// We verify: 1) agent is online (PID alive), 2) messages deliver (no infinite hold)
const badgeStates = await page.evaluate(() => {
  const badges = [...document.querySelectorAll('[data-agent-status-surface]')]
  return badges.map(b => ({ id: b.dataset.agentId, text: b.textContent?.trim() }))
})
console.log('=== agent states ===')
console.log(JSON.stringify(badgeStates, null, 1))
await page.screenshot({ path: '/tmp/macmini-638-gate.png' })
console.log('NOTE: attended-gate runs host-side. Verify via: send a message to an agent')
console.log('whose session you ARE attending → message should NOT inject immediately (held).')
console.log('Then leave the session → message should deliver on next tick (2s).')
await browser.close()

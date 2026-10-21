import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => /index/i.test(p.url()))
if (!page) { console.log('NO PAGE'); process.exit(1) }

// Check if the stale-simulate hook is on globalThis
const hookExists = await page.evaluate(() => typeof globalThis.__guguSimulateStaleSubscription === 'function')
console.log('__guguSimulateStaleSubscription on globalThis:', hookExists)
if (!hookExists) {
  console.log('⚠️ Hook not exposed! Build may not include #874.')
  await browser.close()
  process.exit(0)
}

// Snapshot presence before
const snap = () => page.evaluate(() => {
  const badges = [...document.querySelectorAll('[data-agent-status-surface]')]
  return badges.map(b => ({ id: b.dataset.agentId, text: b.textContent?.trim() }))
})
const before = await snap()
console.log('=== BEFORE stale-simulate ===')
console.log(JSON.stringify(before, null, 1))
await page.screenshot({ path: '/tmp/macmini-840-before.png' })

// Force stale on all subscribed channels
const staled = await page.evaluate(() => {
  // Try staling the user event bus channel (presence)
  const labels = ['gugu:user:', 'agent:', 'private:user']
  let count = 0
  for (const label of labels) {
    if (globalThis.__guguSimulateStaleSubscription(label)) count++
  }
  // Also try staling ALL channels by calling with empty (finds first match)
  // The function matches by labelOrId partial? Let's try specific labels from the registry
  return count
})
console.log(`stale-simulated on ${staled} channels`)

// Wait for watchdog tick (≤30s) — poll every 5s for reconnection
console.log('waiting for watchdog tick (polling every 5s, max 35s)...')
let healed = false
for (let i = 0; i < 7; i++) {
  await page.waitForTimeout(5000)
  const now = await snap()
  const onlineAgents = now.filter(a => !a.text?.includes('离线')).length
  console.log(`  [${(i+1)*5}s] online badges: ${onlineAgents}`)
  // Check console for reconnect warnings
  const _logs = await page.evaluate(() => (window.__staleLogs || []))
  healed = healed || onlineAgents > 0
}
const after = await snap()
console.log('=== AFTER stale-simulate + wait ===')
console.log(JSON.stringify(after, null, 1))
await page.screenshot({ path: '/tmp/macmini-840-after.png' })
console.log(`=== self-heal result: presence recovered = ${healed} ===`)
await browser.close()

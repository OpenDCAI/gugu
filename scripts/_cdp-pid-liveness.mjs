import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => /index/i.test(p.url()))
if (!page) { console.log('NO PAGE'); process.exit(1) }

// Open an agent chat first
const chatRow = page.getByText(/CMP-CLAUDE|CMP-CODEX|YATU/i).first()
try { await chatRow.click({ timeout: 5000 }) } catch (e) { console.log('could not click chat row:', e.message) }
await page.waitForTimeout(3000)

const getBadgeStates = () => page.evaluate(() => {
  const badges = [...document.querySelectorAll('[data-agent-status-surface]')]
  return badges.map(b => ({ surface: b.dataset.agentStatusSurface, text: b.textContent?.trim(), id: b.dataset.agentId }))
})

const before = await getBadgeStates()
console.log('=== status badges in chat-header (BEFORE) ===')
console.log(JSON.stringify(before, null, 1))

// Poll for offline flashes over 5s
let flashes = 0
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(500)
  const states = await getBadgeStates()
  const nowOffline = states.filter(s => s.text?.includes('离线'))
  const wasOnline = before.filter(b => !b.text?.includes('离线'))
  if (nowOffline.length > 0 && wasOnline.length > 0) {
    const flipped = nowOffline.filter(o => {
      const prev = before.find(b => b.id === o.id)
      return prev && !prev.text?.includes('离线')
    })
    if (flipped.length > 0) {
      flashes++
      console.log(`  [${i*500}ms] FLASH: ${flipped.map(f=>f.text).join(', ')}`)
    }
  }
}
console.log(`=== offline flashes in 5s: ${flashes} (expect 0 for PID-liveness #833) ===`)
await page.screenshot({ path: '/tmp/macmini-833-pid.png' })
await browser.close()

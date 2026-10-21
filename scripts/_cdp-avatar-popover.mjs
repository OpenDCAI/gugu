import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => /index/i.test(p.url()))
if (!page) { console.log("NO PAGE"); process.exit(1) }

// Screenshot the chat list (avatar badges visible)
await page.screenshot({ path: '/tmp/macmini-avatar-chatlist.png' })

// Open an agent chat + hover the header status → popover
const chatRow = page.getByText(/YATU|CMP-|Agent/i).first()
try { await chatRow.click({ timeout: 3000 }) } catch {}
await page.waitForTimeout(2000)

const trigger = page.locator('[data-agent-status-surface="chat-header"]').first()
if (await trigger.count() > 0) {
  await trigger.hover({ force: true })
  await page.waitForTimeout(500)
  const popover = page.locator('[data-testid="agent-recent-action-popover"]')
  if (await popover.count() > 0) {
    const text = await popover.innerText()
    console.log('=== popover text ===')
    console.log(text)
    await page.screenshot({ path: '/tmp/macmini-avatar-popover.png' })
  } else {
    console.log('NO POPOVER on hover')
  }
} else {
  console.log('NO chat-header status trigger (not an agent chat?)')
}

// Check avatar badge colors (computed style)
const badgeColors = await page.evaluate(() => {
  const dots = [...document.querySelectorAll('.av-status__dot')]
  return dots.slice(0, 5).map(d => {
    const bg = getComputedStyle(d).backgroundColor
    return { bg, parent: d.closest('.av-status')?.className }
  })
})
console.log('=== badge colors ===')
console.log(JSON.stringify(badgeColors, null, 1))
await browser.close()

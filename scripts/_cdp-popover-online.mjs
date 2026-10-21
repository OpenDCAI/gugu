import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => /index/i.test(p.url()))
if (!page) { console.log('NO PAGE'); process.exit(1) }

// Find an IDLE (online, green) agent chat to open
const idleChats = await page.evaluate(() => {
  const _rows = [...document.querySelectorAll('[data-testid*="chat"]')]
  // Just get visible text to find an agent chat name
  return document.body.innerText.match(/(CMP-\w+|YATU[\w-]+|MINI-\w+)/g)?.slice(0, 5) || []
})
console.log('agent chats found:', JSON.stringify(idleChats))

// Try opening each + check if status is online (not 离线)
for (const name of idleChats.slice(0, 5)) {
  try {
    await page.getByText(name).first().click({ timeout: 3000 })
    await page.waitForTimeout(2000)
    const status = await page.evaluate(() => {
      const s = document.querySelector('[data-agent-status-surface="chat-header"]')
      return s?.textContent?.trim() || '(no status surface)'
    })
    console.log(`chat ${name}: status = ${status}`)
    if (status && !status.includes('离线')) {
      // Online! Hover for popover
      const trigger = page.locator('[data-agent-status-surface="chat-header"]').first()
      await trigger.hover({ force: true })
      await page.waitForTimeout(500)
      const popover = page.locator('[data-testid="agent-recent-action-popover"]')
      if (await popover.count() > 0) {
        const text = await popover.innerText()
        console.log('=== POPOVER (online agent) ===')
        console.log(text)
        await page.screenshot({ path: '/tmp/macmini-popover-online.png' })
      } else {
        console.log('(no popover on hover)')
      }
      break
    }
  } catch (e) {
    console.log(`chat ${name}: ${e.message.slice(0, 60)}`)
  }
}
await browser.close()

import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => /index/i.test(p.url()))
if (!page) { console.log('NO PAGE'); process.exit(1) }
await page.waitForTimeout(3000)
await page.screenshot({ path: '/tmp/macmini-baseline-state.png' })
const text = await page.evaluate(() => document.body.innerText.slice(0, 500))
console.log('--- visible text ---')
console.log(text)
const badges = await page.locator('[data-agent-status-surface]').count()
const chatRows = await page.locator('[data-testid*="chat"], .chat-row, button').count()
console.log(`status surfaces: ${badges}, buttons: ${chatRows}`)
await browser.close()

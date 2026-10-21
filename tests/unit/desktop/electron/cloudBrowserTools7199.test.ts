import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PERSON_TOOLS,
  personToolsOf,
  redactOutputFiles,
  redactToolResult,
  withoutOwnFilename,
  type AgentBrowserBridge,
} from '../../../../apps/desktop/electron/browser-agent-mcp'
import { guguSessionSurfaceBlock } from '../../../../apps/desktop/electron/capability-bundle'

/**
 * #7199 云电脑上的 agent 拿到的浏览器工具:多出「请人登录 / 请人接手」两个,工具结果里的已填密码交回前盖掉,
 * 提示里说的是「你自己的浏览器,人在和你的聊天里看着」,并交代别跟人说它在哪台机器上。
 */
const desktopBridge: AgentBrowserBridge = {
  openTransport: async () => ({ close() {} }),
  toolStarting: () => ({ ok: true }),
  toolFinished: () => {},
  setInitialUrl: () => {},
  workspaceRoot: async () => null,
}

const previousMode = process.env.GUGU_SERVER_MODE
afterEach(() => {
  if (previousMode === undefined) delete process.env.GUGU_SERVER_MODE
  else process.env.GUGU_SERVER_MODE = previousMode
})

describe('#7199 cloud browser tools', () => {
  it('桌面会话页的浏览器没有请人来的工具;云浏览器两个都有', () => {
    expect(personToolsOf(desktopBridge)).toEqual([])
    const cloud = { ...desktopBridge, requestLogin: async () => ({ ok: true, message: '' }), requestTakeover: async () => ({ ok: true, message: '' }) }
    expect(personToolsOf(cloud).map((tool) => tool.name)).toEqual(['browser_request_login', 'browser_request_takeover'])
    // 说明里明说:别在聊天里要密码
    expect(PERSON_TOOLS[0].description).toMatch(/never ask for a password in chat/)
  })

  it('工具结果里的文字过一遍 redact,图片原样', () => {
    const result = redactToolResult(
      {
        content: [
          { type: 'text', text: '- textbox "密码" [ref=e4]: S3cret-pass!' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      },
      (text) => text.split('S3cret-pass!').join('••••••'),
    )
    expect(result.content[0]).toEqual({ type: 'text', text: '- textbox "密码" [ref=e4]: ••••••' })
    expect(result.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
    // 桌面那份没有 redact:原样
    const untouched = { content: [{ type: 'text' as const, text: 'x' }] }
    expect(redactToolResult(untouched, undefined)).toBe(untouched)
  })

  it('咕咕 server 上的提示说的是你自己的浏览器、人在聊天里看,别说它在哪台机器上;登录走保险箱', () => {
    process.env.GUGU_SERVER_MODE = '1'
    const block = guguSessionSurfaceBlock('acp', 'codex', true, true)
    expect(block).toContain('drive your own browser')
    expect(block).toContain('do not tell the person which machine')
    expect(block).toContain('browser_request_login')
    expect(block).not.toContain("this session's pane")
    delete process.env.GUGU_SERVER_MODE
    expect(guguSessionSurfaceBlock('acp', 'codex', true, true)).toContain("this session's pane")
  })

  it('要脱敏时工具不许自己挑文件名(截图除外):内容回到结果里才盖得住', () => {
    expect(withoutOwnFilename('browser_snapshot', { filename: 'a.md', depth: 2 })).toEqual({ depth: 2 })
    expect(withoutOwnFilename('browser_console_messages', { filename: 'c.log', level: 'info' })).toEqual({ level: 'info' })
    expect(withoutOwnFilename('browser_take_screenshot', { filename: 's.png' })).toEqual({ filename: 's.png' })
    expect(withoutOwnFilename('browser_click', { target: 'e1' })).toEqual({ target: 'e1' })
  })

  it('Playwright 这一步自己写的文字文件也盖掉;旧文件、图片不动', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-browser-out-'))
    const old = path.join(dir, 'page-old.yml')
    fs.writeFileSync(old, 'textbox "密码": S3cret-pass!')
    fs.utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const since = Date.now() - 1_000
    fs.writeFileSync(path.join(dir, 'page-new.yml'), 'textbox "密码": S3cret-pass!')
    fs.writeFileSync(path.join(dir, 'console.log'), 'GET /login?pw=S3cret-pass!')
    fs.writeFileSync(path.join(dir, 'shot.png'), 'S3cret-pass!')
    redactOutputFiles(dir, since, (text) => text.split('S3cret-pass!').join('••••••'))
    expect(fs.readFileSync(path.join(dir, 'page-new.yml'), 'utf8')).toBe('textbox "密码": ••••••')
    expect(fs.readFileSync(path.join(dir, 'console.log'), 'utf8')).toBe('GET /login?pw=••••••')
    expect(fs.readFileSync(path.join(dir, 'shot.png'), 'utf8')).toBe('S3cret-pass!')
    expect(fs.readFileSync(old, 'utf8')).toContain('S3cret-pass!')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

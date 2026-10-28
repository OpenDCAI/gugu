import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PERSON_TOOLS,
  browserUseAppInstalled,
  createBrowserAppProgram,
  personToolsOf,
  redactOutputFiles,
  redactToolResult,
  serverBrowserMcpServers,
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

describe('#7199 server 上的 Browser Use App', () => {
  const program = { extensionId: 'browser-use', server: 'browser-use', native: 'browser-use' as const,
    digest: 'd', command: 'Gugu Browser Use', args: [], env: {}, cwd: '/tmp', dataDir: '/tmp' }

  it('桥有请人来(云浏览器)时 App 一并列出,调用交给桥;不开页签', async () => {
    const cloud = {
      ...desktopBridge,
      openTransport: vi.fn(async () => ({ close() {} })),
      toolStarting: vi.fn(() => ({ ok: true as const })),
      requestLogin: vi.fn(async () => ({ ok: true, message: 'filled' })),
      requestTakeover: vi.fn(async () => ({ ok: false, message: 'declined' })),
    }
    const provider = createBrowserAppProgram(() => cloud)
    try {
      const names = (await provider.tools()).map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(['browser_navigate', 'browser_snapshot', 'browser_request_login', 'browser_request_takeover']))
      // 与 gugu-browser 那台同名,各一份
      expect(names.filter((name) => name === 'browser_request_login')).toHaveLength(1)
      const signal = new AbortController().signal
      expect(await provider.call(program, { name: 'browser_request_login', arguments: { reason: ' 登录邮箱 ' }, _meta: { 'gugu/sessionId': 's1' } }, signal))
        .toEqual({ content: [{ type: 'text', text: 'filled' }] })
      expect(cloud.requestLogin).toHaveBeenCalledWith('s1', { reason: '登录邮箱' }, signal)
      expect(await provider.call(program, { name: 'browser_request_takeover', arguments: { reason: '验证码' }, _meta: { 'gugu/sessionId': 's1' } }, signal))
        .toMatchObject({ isError: true, content: [{ type: 'text', text: 'declined' }] })
      expect(cloud.requestTakeover).toHaveBeenCalledWith('s1', { reason: '验证码' }, signal)
      expect(cloud.toolStarting).not.toHaveBeenCalled()
      expect(cloud.openTransport).not.toHaveBeenCalled()
    } finally {
      await provider.retire('browser-use')
    }
  })

  it('桌面桥没有请人来:App 的清单里也没有,点名调就拒', async () => {
    const provider = createBrowserAppProgram(() => desktopBridge)
    try {
      const names = (await provider.tools()).map((tool) => tool.name)
      expect(names).toContain('browser_navigate')
      expect(names).not.toContain('browser_request_login')
      expect(names).not.toContain('browser_request_takeover')
      expect(await provider.call(program, { name: 'browser_request_login', _meta: { 'gugu/sessionId': 's1' } }, new AbortController().signal))
        .toMatchObject({ isError: true })
    } finally {
      await provider.retire('browser-use')
    }
  })
})

describe('#7199 server 上的会话带哪一套浏览器工具', () => {
  const app = (extensionId: string, native?: 'browser-use' | 'computer-use') => ({ extensionId, server: extensionId, digest: 'd',
    command: 'x', args: [], env: {}, cwd: '/tmp', dataDir: '/tmp', ...(native ? { native } : {}) })
  const guguBrowser = [{ name: 'gugu-browser', transport: 'http' as const, url: 'http://127.0.0.1:1/mcp', headers: [] }]

  it('装着、开着、许给工具的 Browser Use 才算;别的 App、停用的、收回权限的不算', () => {
    const refusals: Record<string, string> = { off: 'Extension off is turned off' }
    const programs = (installed: ReturnType<typeof app>[]) => ({ installed: () => installed, agentToolsRefusal: (id: string) => refusals[id] ?? null })
    expect(browserUseAppInstalled(programs([]))).toBe(false)
    expect(browserUseAppInstalled(programs([app('computer', 'computer-use'), app('plain')]))).toBe(false)
    expect(browserUseAppInstalled(programs([app('off', 'browser-use')]))).toBe(false)
    expect(browserUseAppInstalled(programs([app('off', 'browser-use'), app('browser', 'browser-use')]))).toBe(true)
  })

  it('没装 App:照旧带 gugu-browser', async () => {
    const build = vi.fn(async () => guguBrowser)
    expect(await serverBrowserMcpServers('s1', { browserUseApp: () => false, guguBrowser: build })).toBe(guguBrowser)
    expect(build).toHaveBeenCalledOnce()
  })

  it('装了 App:一个也不带(浏览器走 App),❌ 两套同名工具', async () => {
    const build = vi.fn(async () => guguBrowser)
    expect(await serverBrowserMcpServers('s1', { browserUseApp: () => true, guguBrowser: build })).toEqual([])
    expect(build).not.toHaveBeenCalled()
  })

  it('读不出装了什么:当没装,照旧带 gugu-browser', async () => {
    const build = vi.fn(async () => guguBrowser)
    expect(await serverBrowserMcpServers('s1', { browserUseApp: () => { throw new Error('extensions not ready') }, guguBrowser: build })).toBe(guguBrowser)
  })
})

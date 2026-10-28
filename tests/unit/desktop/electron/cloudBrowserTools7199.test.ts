import { randomUUID } from 'node:crypto'
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
  withoutOwnFilename,
  type AgentBrowserBridge,
} from '../../../../apps/desktop/electron/browser-agent-mcp'
import { createDesktopGuguMcpHost, type DesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'
import {
  CLOUD_BROWSER_RULE,
  NO_BROWSER_RULE,
  buildSessionBundle,
  guguSessionSurfaceBlock,
  loadCodexAppServerCapabilities,
  setBrowserUseApp,
} from '../../../../apps/desktop/electron/capability-bundle'

/**
 * #7199 云电脑上的 agent 拿到的浏览器工具:多出「请人登录 / 请人接手」两个,工具结果里的已填密码交回前盖掉,
 * 提示里说的是「你自己的浏览器,人在和你的聊天里看着」,并交代别跟人说它在哪台机器上。
 * 浏览器只有 Browser Use App 一条路:没装就没有浏览器工具,提示照实说(旧的 gugu-browser 已去掉)。
 */
const desktopBridge: AgentBrowserBridge = {
  openTransport: async () => ({ close() {} }),
  toolStarting: () => ({ ok: true }),
  toolFinished: () => {},
  setInitialUrl: () => {},
  workspaceRoot: async () => null,
}

const hosts: DesktopGuguMcpHost[] = []
afterEach(async () => {
  setBrowserUseApp(null)
  await Promise.all(hosts.splice(0).map((host) => host.dispose().catch(() => undefined)))
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

describe('#7199 这台机器装没装 Browser Use', () => {
  const app = (extensionId: string, native?: 'browser-use' | 'computer-use') => ({ extensionId, server: extensionId, digest: 'd',
    command: 'x', args: [], env: {}, cwd: '/tmp', dataDir: '/tmp', ...(native ? { native } : {}) })

  it('装着、开着、许给工具的 Browser Use 才算;别的 App、停用的、收回权限的不算', () => {
    const refusals: Record<string, string> = { off: 'Extension off is turned off' }
    const programs = (installed: ReturnType<typeof app>[]) => ({ installed: () => installed, agentToolsRefusal: (id: string) => refusals[id] ?? null })
    expect(browserUseAppInstalled(programs([]))).toBe(false)
    expect(browserUseAppInstalled(programs([app('computer', 'computer-use'), app('plain')]))).toBe(false)
    expect(browserUseAppInstalled(programs([app('off', 'browser-use')]))).toBe(false)
    expect(browserUseAppInstalled(programs([app('off', 'browser-use'), app('browser', 'browser-use')]))).toBe(true)
  })
})

describe('#7199 开场提示里的浏览器:只看 Browser Use App', () => {
  const server = (installed: () => boolean) => setBrowserUseApp({ installed, server: true })
  async function bundleFor(personalAssistant?: true) {
    const host = createDesktopGuguMcpHost()
    hosts.push(host)
    return buildSessionBundle({
      runtime: {
        authProvider: { getAuth: async () => ({ accessToken: 'token', userId: randomUUID() }) },
        env: { GUGU_HOME: '/tmp/gugu-cloud-browser-7199' },
      },
      agentUserId: randomUUID(),
      threadRootId: null,
      autonomy: null,
      socialBridgeDeps: { host, grantKey: `taskpage:${randomUUID()}`, getSupabaseUrl: () => 'https://supabase.example', getSupabaseAnonKey: () => 'anon-key',
        ...(personalAssistant ? { personalAssistant, runSessionAction: async () => ({}) } : {}) },
    })
  }
  const ctx = { cwd: '/tmp/gugu-cloud-browser-7199', lifecycle: 'fresh' as const }
  const instructions = async (personalAssistant?: true) => {
    const bundle = await bundleFor(personalAssistant)
    // 能力包里 ❌ 再有一台自己的浏览器 server
    expect(bundle.mcpServers.map((server) => server.name)).not.toContain('gugu-browser')
    return loadCodexAppServerCapabilities(bundle, ctx).developerInstructions ?? ''
  }

  it('server 装着 App:云浏览器那段,说的是 Browser Use 的 browser_* 工具,不再点名 gugu-browser', async () => {
    server(() => true)
    const text = await instructions()
    expect(text).toContain(CLOUD_BROWSER_RULE)
    expect(CLOUD_BROWSER_RULE).toContain('(if they are not in your tool list, find them with `catalog_list`)')
    expect(text).not.toContain(NO_BROWSER_RULE)
    expect(CLOUD_BROWSER_RULE).toContain('`browser_*` tools of the Browser Use App')
    expect(CLOUD_BROWSER_RULE).toContain('drive your own browser')
    expect(CLOUD_BROWSER_RULE).toContain('do not tell the person which machine')
    expect(CLOUD_BROWSER_RULE).toContain('browser_request_login')
    expect(CLOUD_BROWSER_RULE).toContain('browser_request_takeover')
    expect(CLOUD_BROWSER_RULE).toContain('never ask\nfor a password in chat')
    expect(text).not.toContain('gugu-browser')
  })

  it('server 没装 App:照实说没有浏览器,问人要不要装;没有浏览器工具', async () => {
    server(() => false)
    expect(NO_BROWSER_RULE).toBe('This machine has no browser for you: the Browser Use App is not installed here. If a task needs a web page, tell the person so and ask whether to install Browser Use on this machine. Only after they agree, call `app_install` for the App `browser-use` (it installs on the machine you run on); its browser tools arrive with your next task, not this one. Until then do not launch your own browser, Playwright, Chrome or a headless scraper to stand in for it, and never claim you looked at a page.')
    const bundle = await bundleFor()
    expect(bundle.mcpServers.some((server) => /browser/.test(server.name))).toBe(false)
    const text = loadCodexAppServerCapabilities(bundle, ctx).developerInstructions ?? ''
    expect(text).toContain(NO_BROWSER_RULE)
    expect(text).not.toContain(CLOUD_BROWSER_RULE)
    expect(text).not.toContain('gugu-browser')
  })

  it('读不出装了什么:当没装(那时也确实没有工具)', async () => {
    server(() => { throw new Error('extensions not ready') })
    const text = await instructions()
    expect(text).toContain(NO_BROWSER_RULE)
    expect(text).not.toContain(CLOUD_BROWSER_RULE)
  })

  it('桌面:装没装 App 都不说浏览器;装着时能力包带 browserUse(Codex 据它关自己的浏览器插件)', async () => {
    for (const installed of [true, false]) {
      setBrowserUseApp({ installed: () => installed, server: false })
      const bundle = await bundleFor()
      expect(bundle.browserUse).toBe(installed ? true : undefined)
      expect(bundle.browserRule).toBeUndefined()
      const text = loadCodexAppServerCapabilities(bundle, ctx).developerInstructions ?? ''
      expect(text).not.toContain(NO_BROWSER_RULE)
      expect(text).not.toContain(CLOUD_BROWSER_RULE)
      expect(text).not.toMatch(/browser_\*/)
    }
    setBrowserUseApp(null)
    expect(await instructions()).not.toContain(NO_BROWSER_RULE)
    expect(guguSessionSurfaceBlock('acp', 'codex', true)).not.toContain(CLOUD_BROWSER_RULE)
    expect(guguSessionSurfaceBlock('acp', 'codex', true, 'app')).toContain(CLOUD_BROWSER_RULE)
    expect(guguSessionSurfaceBlock('acp', 'codex', true, 'none')).toContain(NO_BROWSER_RULE)
  })

  it('server 上的个人助理:两段浏览器提示都不给(与从前一样)', async () => {
    for (const installed of [true, false]) {
      server(() => installed)
      const bundle = await bundleFor(true)
      expect(bundle.browserRule).toBeUndefined()
      const text = await instructions(true)
      expect(text).not.toContain(CLOUD_BROWSER_RULE)
      expect(text).not.toContain(NO_BROWSER_RULE)
    }
  })

  it('server 上装着 App 的会话,能力包带 browserUse;没装 / 读不出不带', async () => {
    server(() => true)
    expect((await bundleFor()).browserUse).toBe(true)
    server(() => false)
    expect((await bundleFor()).browserUse).toBeUndefined()
    server(() => { throw new Error('extensions not ready') })
    expect((await bundleFor()).browserUse).toBeUndefined()
  })
})

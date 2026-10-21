// #6264 咕咕 server 上的程序要「打开网页」($BROWSER / xdg-open,如 `gh auth login --web`):照 VS Code 远端的
// $BROWSER,转到正看着这台机器的咕咕桌面上打开。
//
// 三段,都用真东西:
//  · 助手脚本:真的写到临时目录、真的用 /bin/sh 跑(起法换成一个把参数原样打出来的假 gugu-server);
//  · `gugu-server open-url` → 真的 attach 套接字 → 账号进程里的应答(路由换成假的,看它收到什么);
//  · 桌面经 SSH 开的「终端」带上同一组环境变量。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPtyAttachServer, type AttachDeps } from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-server'
import { OPEN_EXTERNAL_CALL } from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-protocol'
import {
  browserHelperScripts,
  installServerBrowserHelpers,
  serverBrowserEnv,
  setServerBrowserHelpers,
} from '../../../../apps/desktop/electron/session/main/core/pty/server-browser-env'
import { quoteShellArg as shQuote } from '../../../../apps/desktop/electron/session/main/utils/shellEscape'
import { answerOpenExternal, type OpenExternalDeps } from '../../../../apps/desktop/electron/session/main/core/session-timeline/remote-open-external'
import { parseOpenUrlArgs, runOpenUrl } from '../../../../apps/desktop/electron/server/open-url-cli'
import type { ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'

const ACCOUNT = '0f8fad5b-d9cb-469f-a165-70867728950e'

function sink() {
  const stream = new PassThrough()
  let text = ''
  stream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
  return { stream, text: () => text }
}

describe('助手脚本($BROWSER / xdg-open)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-browser-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    setServerBrowserHelpers(null)
  })

  // 假 gugu-server:把收到的参数一行一个打出来。路径里带空格与单引号,验证脚本的引号。
  function fakeLauncher(): string {
    const launcherDir = path.join(dir, "it's here")
    fs.mkdirSync(launcherDir)
    const file = path.join(launcherDir, 'gugu-server')
    fs.writeFileSync(file, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 })
    return file
  }

  it('gugu-browser hands its argument to `gugu-server open-url` verbatim', () => {
    const home = path.join(dir, 'home')
    const helpers = installServerBrowserHelpers({ serverHome: home, account: ACCOUNT, fallbackLauncher: [fakeLauncher()] })
    const out = execFileSync('/bin/sh', [path.join(helpers, 'gugu-browser'), 'https://github.com/login/device?a=1&b=2'], {
      encoding: 'utf8',
    })
    expect(out.trim().split('\n')).toEqual(['open-url', '--', 'https://github.com/login/device?a=1&b=2'])
  })

  it('prefers the installed launcher (current/bin/gugu-server) so upgrades need no rewrite', () => {
    const home = path.join(dir, 'home')
    fs.mkdirSync(path.join(home, 'current', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'current', 'bin', 'gugu-server'), '#!/bin/sh\necho installed "$@"\n', { mode: 0o755 })
    const helpers = installServerBrowserHelpers({ serverHome: home, account: ACCOUNT, fallbackLauncher: ['/nope'] })
    expect(execFileSync('/bin/sh', [path.join(helpers, 'gugu-browser'), 'https://x.test/'], { encoding: 'utf8' }).trim()).toBe(
      'installed open-url -- https://x.test/'
    )
  })

  it('xdg-open takes web pages and passes anything else to the real xdg-open further down PATH', () => {
    const home = path.join(dir, 'home')
    const helpers = installServerBrowserHelpers({ serverHome: home, account: ACCOUNT, fallbackLauncher: [fakeLauncher()] })
    const realDir = path.join(dir, 'real')
    fs.mkdirSync(realDir)
    fs.writeFileSync(path.join(realDir, 'xdg-open'), '#!/bin/sh\necho real "$@"\n', { mode: 0o755 })
    const env = { ...process.env, PATH: `${helpers}:${realDir}:/usr/bin:/bin` }
    const run = (arg: string) => execFileSync('/bin/sh', [path.join(helpers, 'xdg-open'), arg], { encoding: 'utf8', env }).trim()
    expect(run('http://localhost:5173/')).toBe('open-url\n--\nhttp://localhost:5173/')
    expect(run('report.html')).toBe('open-url\n--\nreport.html')
    expect(run('/tmp/photo.png')).toBe('real /tmp/photo.png')
  })

  it('agents and terminals get BROWSER, the helpers first on PATH, and which account they belong to', () => {
    expect(serverBrowserEnv('/usr/bin')).toEqual({})
    setServerBrowserHelpers({ dir: '/h/.gugu-server/bin', account: ACCOUNT })
    expect(serverBrowserEnv('/usr/bin:/h/.gugu-server/bin:/bin')).toEqual({
      BROWSER: '/h/.gugu-server/bin/gugu-browser',
      PATH: '/h/.gugu-server/bin:/usr/bin:/bin',
      GUGU_SERVER_ACCOUNT: ACCOUNT,
    })
  })

  it('quotes launcher words for sh', () => {
    expect(shQuote("a'b c")).toBe(`'a'\\''b c'`)
    expect(browserHelperScripts(['/x y/gugu-server'])['gugu-browser']).toContain(`exec '/x y/gugu-server' open-url -- "$@"`)
  })
})

describe('gugu-server open-url → attach 套接字 → 账号进程', () => {
  let home: string
  let server: { socketPath: string; close: () => Promise<void> } | null = null
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-openurl-'))
  })
  afterEach(async () => {
    await server?.close()
    server = null
    fs.rmSync(home, { recursive: true, force: true })
  })

  const account = (): ServerAccount => ({
    userId: ACCOUNT,
    email: 'a@example.com',
    addedAt: null,
    dir: home,
    dataDir: home,
    homeDir: home,
    signedIn: true,
    signedOut: null,
  })

  async function serve(deps: OpenExternalDeps) {
    const attachDeps: AttachDeps = {
      warn: vi.fn(),
      call: async (type, payload) =>
        type === OPEN_EXTERNAL_CALL ? answerOpenExternal(payload, deps) : { error: { code: 'unsupported_call', message: type } },
    }
    server = await startPtyAttachServer(home, attachDeps)
  }

  function fakeDeps(outcome: 'opened' | 'queued') {
    const open = vi.fn(async () => (outcome === 'opened' ? { opened: true as const } : { queued: true as const }))
    const deps: OpenExternalDeps = {
      route: { open, watching: () => false },
      sessionFromPtyId: (ptyId) => (ptyId === 'claude:conv-7' ? 'conv-7' : null),
      sessionRoots: async () => [{ sessionId: 'conv-1', root: '/srv/app' }],
      isFile: async () => true,
    }
    return { deps, open }
  }

  it('opens quietly and tells the account process which session asked (from GUGU_PTY_ID)', async () => {
    const { deps, open } = fakeDeps('opened')
    await serve(deps)
    const err = sink()
    const code = await runOpenUrl(['--', 'https://github.com/login/device'], { stdout: sink().stream, stderr: err.stream }, {
      env: { GUGU_PTY_ID: 'claude:conv-7', GUGU_SERVER_ACCOUNT: ACCOUNT },
      cwd: () => '/tmp',
      accounts: () => [account()],
    })
    expect(code).toBe(0)
    expect(err.text()).toBe('')
    expect(open).toHaveBeenCalledWith('conv-7', { kind: 'external', url: 'https://github.com/login/device' }, 'pinned')
  })

  it('finds the session by working directory when there is no GUGU_PTY_ID', async () => {
    const { deps, open } = fakeDeps('opened')
    await serve(deps)
    await runOpenUrl(['http://localhost:5173/'], { stdout: sink().stream, stderr: sink().stream }, {
      env: {},
      cwd: () => '/srv/app/web',
      accounts: () => [account()],
    })
    expect(open).toHaveBeenCalledWith('conv-1', { kind: 'external', url: 'http://localhost:5173/' }, 'pinned')
  })

  it('says plainly and prints the URL when nobody is looking right now (exit 0: the program carries on)', async () => {
    await serve(fakeDeps('queued').deps)
    const err = sink()
    const code = await runOpenUrl(['https://x.test/'], { stdout: sink().stream, stderr: err.stream }, {
      env: {},
      cwd: () => '/',
      accounts: () => [account()],
    })
    expect(code).toBe(0)
    expect(err.text()).toContain('https://x.test/')
  })

  it('fails with exit 1 and the URL when the account process is not running', async () => {
    const err = sink()
    const code = await runOpenUrl(['https://x.test/'], { stdout: sink().stream, stderr: err.stream }, {
      env: {},
      cwd: () => '/',
      accounts: () => [account()],
    })
    expect(code).toBe(1)
    expect(err.text()).toContain('https://x.test/')
  })

  it('parses args: --account, the env fallback, and -- before the target', () => {
    expect(parseOpenUrlArgs(['--account', ACCOUNT, 'https://a/'], {})).toEqual({ account: ACCOUNT, target: 'https://a/' })
    expect(parseOpenUrlArgs(['--', '--account'], { GUGU_SERVER_ACCOUNT: ACCOUNT })).toEqual({ account: ACCOUNT, target: '--account' })
    expect(parseOpenUrlArgs([], {})).toMatchObject({ error: expect.any(String) })
    expect(parseOpenUrlArgs(['--account', 'bad id', 'x'], {})).toMatchObject({ error: expect.any(String) })
  })
})

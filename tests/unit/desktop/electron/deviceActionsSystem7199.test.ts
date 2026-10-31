// #7199 系统(system.* 5 个)与终端与自动化(script.jxa / script.shell / sdef.get):系统信息只读、不带能认出机器的标识;
// 脚本每次都要人点头、问句带脚本开头,screencapture 一律拒,工作目录只认连上了的位置,输出有上限、超时说超时;
// 脚本字典经系统的 OSACopyScriptingDefinitionFromURL 取(❌ /usr/bin/sdef:没装 Xcode 的电脑上跑不了),系统标准 suite 的 xi:include 接进来。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createSystemFamily, invokesScreenCapture } from '../../../../apps/desktop/electron/device-actions/families/system'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import type { ExecResult } from '../../../../apps/desktop/electron/device-actions/mac-scripts'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

let dir: string
let home: string
const realHome = process.env.HOME

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-das-'))
  home = path.join(dir, 'home')
  for (const d of ['Desktop', 'Documents', 'Downloads']) fs.mkdirSync(path.join(home, d), { recursive: true })
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(dir, { recursive: true, force: true })
})

type ExecFn = FamilyDeps['exec']
const ctx = () => ({ callId: 'c', signal: new AbortController().signal, note: () => undefined })
const done = (stdout: string, code = 0, stderr = ''): ExecResult => ({ stdout, stderr, code })

/** 按「命令 参数…」查表回答的假 exec;没登记的命令回非 0。 */
function table(answers: Record<string, string | ExecResult>) {
  return vi.fn<ExecFn>(async (file, args) => {
    const key = [file, ...args].join(' ')
    const hit = answers[key]
    if (hit === undefined) return done('', 1, `unexpected command: ${key}`)
    return typeof hit === 'string' ? done(hit) : hit
  })
}

function setup(exec: ExecFn, appDirs: string[] = [], jxa: FamilyDeps['jxa'] = vi.fn(async () => ({}))) {
  const store = createDeviceActionGrantsStore(path.join(dir, 'grants.json'))
  const deps: FamilyDeps = {
    platform: 'darwin',
    nativeDir: null,
    now: () => new Date('2026-10-15T08:00:00Z'),
    homedir: () => home,
    clipboardRead: () => '',
    clipboardWrite: vi.fn(),
    notify: vi.fn(async () => ({ shown: true })),
    openExternal: vi.fn(async () => undefined),
    trashItem: vi.fn(async () => undefined),
    jxa,
    exec,
    macHelper: () => ({ available: () => ({ ok: true as const }), call: vi.fn(async () => ({})) as never, dispose: () => undefined }),
    cua: () => ({ available: () => ({ ok: true as const }), callTool: vi.fn(async () => ({ content: [] })), stop: () => undefined, dispose: () => undefined }),
  }
  const p = createDeviceActionsProvider({ store, families: [createSystemFamily({ appDirs: () => appDirs })], deps })
  store.setGroup('system', true)
  store.setGroup('shell', true)
  return { store, p }
}

const run = (p: ReturnType<typeof setup>['p'], action: string, args: Record<string, unknown>) => p.provider.run(action, args, ctx())
const ID = 'uid=501(apple) gid=20(staff) groups=20(staff),12(everyone),80(admin),33(_appstore)\n'

describe('系统', () => {
  it('两组都不弹系统授权、一点就连上;只在 Mac 上有', async () => {
    const { p } = setup(table({}))
    expect(p.groups().map((g) => g.id)).toEqual(['system', 'shell'])
    expect(p.groups().every((g) => !g.probe)).toBe(true)
    expect(await p.connect('system')).toEqual({ ok: true })
    expect(createSystemFamily().groups.every((g) => g.platforms.join() === 'darwin')).toBe(true)
  })

  it('system.get:版本、型号、芯片、内存、磁盘、开机时间;detailed 加概览,❌ 序列号 / 硬件 UUID', async () => {
    const exec = table({
      '/usr/bin/sw_vers': 'ProductName:\t\tmacOS\nProductVersion:\t\t26.5.2\nBuildVersion:\t\t25F84\n',
      '/usr/sbin/sysctl -n hw.model machdep.cpu.brand_string hw.memsize kern.boottime': 'MacBookPro18,1\nApple M1 Pro\n34359738368\n{ sec = 1791870682, usec = 848281 } Tue Oct 13 13:51:22 2026\n',
      '/usr/sbin/scutil --get ComputerName': '小杨的 MacBook Pro\n',
      [`/bin/df -k ${home}`]: 'Filesystem   1024-blocks      Used Available Capacity  iused     ifree %iused  Mounted on\n/dev/disk3s1   482797652 415058536  18603140    96% 11462974 186031400    6%   /System/Volumes/Data\n',
      '/usr/sbin/system_profiler SPHardwareDataType SPSoftwareDataType -json': JSON.stringify({
        SPHardwareDataType: [{ _name: 'hardware_overview', chip_type: 'Apple M1 Pro', machine_name: 'MacBook Pro', serial_number: 'C02XXXX', platform_UUID: 'AAAA', provisioning_UDID: 'BBBB' }],
        SPSoftwareDataType: [{ _name: 'os_overview', os_version: 'macOS 26.5.2 (25F84)', uptime: 'up 2:0:59:12' }],
      }),
    })
    const { p } = setup(exec)
    const basic = await run(p, 'system.get', {})
    expect(basic).toMatchObject({
      ok: true,
      data: {
        os: { name: 'macOS', version: '26.5.2', build: '25F84' },
        computer_name: '小杨的 MacBook Pro',
        model_identifier: 'MacBookPro18,1',
        chip: 'Apple M1 Pro',
        memory_gb: 32,
        disk: { volume: '/System/Volumes/Data', available_gb: 17.7, used_percent: 96 },
        uptime_seconds: Date.parse('2026-10-15T08:00:00Z') / 1000 - 1_791_870_682,
      },
    })
    expect(basic.ok && (basic.data as Record<string, unknown>).hardware).toBeUndefined()
    const detailed = await run(p, 'system.get', { detailed: true })
    const data = detailed.ok ? (detailed.data as { hardware: Record<string, unknown>; software: Record<string, unknown> }) : null
    expect(data?.hardware).toEqual({ chip_type: 'Apple M1 Pro', machine_name: 'MacBook Pro' })
    expect(data?.software).toEqual({ os_version: 'macOS 26.5.2 (25F84)', uptime: 'up 2:0:59:12' })
    expect(JSON.stringify(detailed)).not.toMatch(/C02XXXX|AAAA|BBBB/)
  })

  it('system.apps.list:扫给定文件夹(含一层子文件夹、❌ 进 .app 里面);文本 plist 直接读、二进制的请 plutil 转;按名字排、search / limit', async () => {
    const apps = path.join(dir, 'Applications')
    const plist = (id: string, version: string) => `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
    const make = (rel: string, content: string | Buffer | null) => {
      const app = path.join(apps, rel)
      fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
      if (content !== null) fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), content)
      return app
    }
    make('Zed.app', plist('dev.zed.Zed', '0.200'))
    make('Utilities/Console.app', plist('com.apple.Console', '1.1'))
    const binary = make('Keynote.app', Buffer.from('bplist00\u0000binary'))
    make('NoPlist.app', null)
    // .app 里面的 .app 不算(那是它自带的辅助程序)。
    make('Zed.app/Contents/Helpers/Inner.app', plist('dev.zed.inner', '1'))
    const exec = table({ [`/usr/bin/plutil -convert xml1 -o - ${path.join(binary, 'Contents', 'Info.plist')}`]: plist('com.apple.iWork.Keynote', '14.4') })
    const { p } = setup(exec, [apps, path.join(dir, 'missing')])
    expect(await run(p, 'system.apps.list', {})).toEqual({
      ok: true,
      data: {
        total: 4,
        apps: [
          { name: 'Console', bundle_id: 'com.apple.Console', version: '1.1', path: path.join(apps, 'Utilities', 'Console.app') },
          { name: 'Keynote', bundle_id: 'com.apple.iWork.Keynote', version: '14.4', path: binary },
          { name: 'NoPlist', bundle_id: null, version: null, path: path.join(apps, 'NoPlist.app') },
          { name: 'Zed', bundle_id: 'dev.zed.Zed', version: '0.200', path: path.join(apps, 'Zed.app') },
        ],
      },
    })
    expect(await run(p, 'system.apps.list', { search: 'IWORK' })).toMatchObject({ ok: true, data: { total: 1, apps: [{ name: 'Keynote' }] } })
    expect(await run(p, 'system.apps.list', { limit: 2 })).toMatchObject({ ok: true, data: { total: 4, truncated: true, apps: [{ name: 'Console' }, { name: 'Keynote' }] } })
  })

  it('system.shell.get / system.user.get:id 的输出拆成用户、组、是否管理员;名字、语言、时区', async () => {
    const answers = table({
      '/usr/bin/id': ID,
      '/usr/bin/id -F': 'Example User\n',
      '/usr/bin/defaults read -g AppleLocale': 'zh_CN\n',
      '/usr/bin/defaults read -g AppleLanguages': '(\n    "zh-Hans-CN",\n    en\n)\n',
    })
    const shell = os.userInfo().shell ?? ''
    const exec = vi.fn<ExecFn>(async (file, args, opts) => (file === shell && args[0] === '--version' ? done('zsh 5.9 (arm64-apple-darwin25.0)\n') : answers(file, args, opts)))
    const { p } = setup(exec)
    expect(await run(p, 'system.shell.get', {})).toMatchObject({
      ok: true,
      data: { default_shell: shell, user: 'apple', uid: 501, gid: 20, groups: ['staff', 'everyone', 'admin', '_appstore'], path: process.env.PATH },
    })
    const user = await run(p, 'system.user.get', {})
    expect(user).toMatchObject({
      ok: true,
      data: { username: 'apple', full_name: 'Example User', uid: 501, home, is_admin: true, locale: 'zh_CN', languages: ['zh-Hans-CN', 'en'], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    })
    expect((user.ok ? (user.data as { utc_offset: string }).utc_offset : '')).toMatch(/^[+-]\d\d:\d\d$/)
  })

  it('system.users.list:默认去掉系统账号(_ 开头、uid < 500、root / daemon / nobody),includeSystem 才列;按 uid 排', async () => {
    const exec = table({
      '/usr/bin/dscl . -list /Users UniqueID': '_spotlight               89\napple                    501\ndaemon                   1\notheruser                   502\nnobody                   -2\nroot                     0\n',
      '/usr/bin/dscl . -list /Users RealName': '_spotlight               Spotlight\napple                    Example User\notheruser                   dev\n     second line of a multi-line name\nroot                     System Administrator\n',
      '/usr/bin/dscl . -list /Users NFSHomeDirectory': 'apple                    /Users/apple\notheruser                   /Users/otheruser\n',
      '/usr/bin/dscl . -list /Users UserShell': 'apple                    /bin/zsh\notheruser                   /bin/bash\n',
      '/usr/bin/dscl . -read /Groups/admin GroupMembership': 'GroupMembership: root apple\n',
      '/usr/bin/who': 'apple            console      Oct 13 14:04 \n',
    })
    const { p } = setup(exec)
    const people = await run(p, 'system.users.list', {})
    expect(people).toMatchObject({
      ok: true,
      data: {
        total: 2,
        users: [
          { username: 'apple', full_name: 'Example User', uid: 501, home: '/Users/apple', shell: '/bin/zsh', is_admin: true, logged_in: true },
          { username: 'otheruser', full_name: 'dev', uid: 502, home: '/Users/otheruser', shell: '/bin/bash', is_admin: false, logged_in: false },
        ],
      },
    })
    const all = await run(p, 'system.users.list', { includeSystem: true })
    expect(all.ok && (all.data as { users: Array<{ username: string }> }).users.map((u) => u.username)).toEqual(['nobody', 'root', 'daemon', '_spotlight', 'apple', 'otheruser'])
  })
})

describe('终端与自动化', () => {
  it('script.shell:没确认 ⇒ needs_confirmation,问句带脚本开头;确认后在家目录用 zsh -c 跑、参数原样;非 0 退出照常回', async () => {
    const exec = vi.fn<ExecFn>(async () => done('hi a b\n', 3, 'warn\n'))
    const { p } = setup(exec)
    const long = `echo hi "$1" "$2" # ${'x'.repeat(200)}`
    const ask = await p.provider.preflight!('script.shell', { script: long, args: ['a', 'b'] })
    expect(ask).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: expect.stringContaining('echo hi "$1"') } })
    expect(ask && !ask.ok && ask.confirm!.question.length).toBeLessThan(170)
    expect(exec).not.toHaveBeenCalled()
    const args = { script: long, args: ['a', 'b'], env: { FOO: 'bar' }, confirmed: true }
    expect(await p.provider.preflight!('script.shell', args)).toBeNull()
    expect(await run(p, 'script.shell', args)).toEqual({ ok: true, data: { cwd: home, exit_code: 3, stdout: 'hi a b', stderr: 'warn' } })
    expect(exec).toHaveBeenCalledWith('/bin/zsh', ['-c', long, 'zsh', 'a', 'b'], expect.objectContaining({ cwd: home, env: { FOO: 'bar' }, signal: expect.any(AbortSignal) }))
    await run(p, 'script.shell', { script: 'ls', shell: 'bash', confirmed: true })
    expect(exec).toHaveBeenLastCalledWith('/bin/bash', ['-c', 'ls', 'bash'], expect.anything())
  })

  it('script.shell:screencapture 一律拒(连确认都不问);参数不对开工前就回', async () => {
    const { p } = setup(table({}))
    for (const script of ['screencapture -x ~/a.png', 'sudo /usr/sbin/screencapture a.png', 'echo ok; FOO=1 nice -n 5 screencapture -c', 'x=$(screencapture -x a.png)']) {
      expect(await p.provider.preflight!('script.shell', { script, confirmed: true })).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('computer.get_window_state') })
    }
    expect(await p.provider.preflight!('script.shell', { script: 'echo screencapture is a word', confirmed: true })).toBeNull()
    expect(await p.provider.preflight!('script.shell', { script: 'ls', shell: 'fish' })).toMatchObject({ code: 'invalid_args' })
    expect(await p.provider.preflight!('script.shell', { script: 'ls', env: { 'A-B': 'x' } })).toMatchObject({ code: 'invalid_args' })
    expect(await p.provider.preflight!('script.shell', { script: 'ls', timeoutMs: 999_999 })).toMatchObject({ code: 'invalid_args' })
    expect(await p.provider.preflight!('script.shell', { script: '   ' })).toMatchObject({ code: 'invalid_args' })
  })

  it('script.shell:工作目录只认连上了的位置;输出各留 64 KB;到点停下回 timeout', async () => {
    const exec = vi.fn<ExecFn>(async () => done('o'.repeat(70_000), 0, 'e'.repeat(10)))
    const { p, store } = setup(exec)
    expect(await run(p, 'script.shell', { script: 'ls', cwd: '~/Documents', confirmed: true })).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('cwd') })
    expect(exec).not.toHaveBeenCalled()
    store.setGroup('files.documents', true)
    const r = await run(p, 'script.shell', { script: 'ls', cwd: '~/Documents', confirmed: true })
    expect(r).toMatchObject({ ok: true, data: { cwd: fs.realpathSync(path.join(home, 'Documents')), stdout_truncated: true, stderr: 'eeeeeeeeee' } })
    expect(r.ok && (r.data as { stdout: string }).stdout.length).toBe(65_536)
    expect(await run(p, 'script.shell', { script: 'ls', cwd: '~/Desktop', confirmed: true })).toMatchObject({ ok: false, code: 'invalid_args' })

    exec.mockImplementation((_file, _args, opts) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    expect(await run(p, 'script.shell', { script: 'sleep 100', timeoutMs: 1000, confirmed: true })).toMatchObject({ ok: false, code: 'timeout' })
  })

  it('script.jxa:osascript -l JavaScript -e 脚本 -- 参数;AppleScript 换 -l;被 macOS 拦下的 Apple Event 说清去哪打开(❌ 把整组标成没授权)', async () => {
    const exec = vi.fn<ExecFn>(async () => done('42\n'))
    const { p } = setup(exec)
    expect(await p.provider.preflight!('script.jxa', { script: 'Application("Safari").windows.length' })).toMatchObject({ code: 'needs_confirmation', confirm: { question: expect.stringContaining('JXA') } })
    expect(await p.provider.preflight!('script.jxa', { script: 'app.doShellScript("screencapture -x /tmp/a.png")', confirmed: true })).toMatchObject({ code: 'invalid_args' })
    expect(await run(p, 'script.jxa', { script: 'Application("Safari").windows.length', args: ['-x'], confirmed: true })).toEqual({ ok: true, data: { exit_code: 0, stdout: '42', stderr: '' } })
    expect(exec).toHaveBeenLastCalledWith('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'Application("Safari").windows.length', '--', '-x'], expect.anything())
    await run(p, 'script.jxa', { script: 'tell application "Finder" to get name', language: 'applescript', confirmed: true })
    expect(exec).toHaveBeenLastCalledWith('/usr/bin/osascript', ['-l', 'AppleScript', '-e', 'tell application "Finder" to get name', '--'], expect.anything())
    exec.mockResolvedValueOnce(done('', 1, '0:40: execution error: Not authorized to send Apple events to Mail. (-1743)'))
    const denied = await run(p, 'script.jxa', { script: 'Application("Mail").accounts()', confirmed: true })
    expect(denied).toMatchObject({ ok: false, code: 'execution_failed', message: expect.stringContaining('Automation → 咕咕 → Mail') })
    expect(p.blocked('shell')).toBeNull()
    exec.mockResolvedValueOnce(done('', 1, '0:5: execution error: Error: boom (-2700)'))
    expect(await run(p, 'script.jxa', { script: 'throw new Error("boom")', confirmed: true })).toEqual({ ok: true, data: { exit_code: 1, stdout: '', stderr: '0:5: execution error: Error: boom (-2700)' } })
  })

  it('invokesScreenCapture:只认真去调 screencapture 的那一段', () => {
    expect(invokesScreenCapture('env FOO=1 screencapture')).toBe(true)
    expect(invokesScreenCapture('ls | xargs screencapture')).toBe(true)
    expect(invokesScreenCapture('$.NSTask.launchedTaskWithLaunchPathArguments("/usr/sbin/screencapture", [])')).toBe(true)
    expect(invokesScreenCapture('grep screencapture notes.txt')).toBe(false)
    expect(invokesScreenCapture('echo done')).toBe(false)
  })
})

describe('脚本字典 sdef.get', () => {
  const SDEF = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE dictionary SYSTEM "file://localhost/System/Library/DTDs/sdef.dtd">
<dictionary title="Fake Terminology">
  <!-- <suite name="commented out"/> -->
  <suite name="Fake Suite" code="Fake" description="Things &amp; stuff">
    <command name="send message" code="FakeSend" description="Send a message">
      <direct-parameter type="text" description="what to send"/>
      <parameter name="to" code="To  " type="text" description="recipient"/>
      <parameter name="urgent" code="Urgt" type="boolean" optional="yes"/>
      <result type="boolean"/>
      <documentation><html><![CDATA[<p>Use <b>send message</b> "x" to "y"</p>]]></html></documentation>
    </command>
    <command name="secret" code="FakeSecr" hidden="yes"/>
    <class name="message" code="Mssg" plural="messages" inherits="item" description="A message">
      <property name="subject" code="subj" type="text" access="r"/>
      <property name="recipients" code="rcps">
        <type type="text" list="yes"/>
      </property>
      <element type="attachment"/>
      <responds-to command="send message"/>
    </class>
    <class-extension extends="application">
      <element type="message"/>
      <property name="unread count" code="UnrC" type="integer" access="r"/>
    </class-extension>
    <enumeration name="priority" code="Prio">
      <enumerator name="low" code="PrLo"/>
      <enumerator name="high" code="PrHi"/>
    </enumeration>
  </suite>
</dictionary>`

  /** 一个空的 .app(按路径找得到);字典由假的 jxa(= OSACopyScriptingDefinitionFromURL)回。 */
  function fakeApp(name: string) {
    const app = path.join(dir, `${name}.app`)
    fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
    return app
  }
  const dictionary = (xml: string | null) => vi.fn<FamilyDeps['jxa']>(async (_script, input) => (xml === null ? { error: -192 } : { xml, for: (input as { path: string }).path }))

  it('经系统接口取字典出摘要:命令(参数)、类(属性 / 元素)、枚举;❌ hidden、注释、CDATA 里的标签', async () => {
    const app = fakeApp('Fake')
    const exec = table({})
    const jxa = dictionary(SDEF)
    const { p } = setup(exec, [], jxa)
    const r = await run(p, 'sdef.get', { app })
    expect(r).toEqual({
      ok: true,
      data: {
        app: 'Fake',
        path: app,
        format: 'summary',
        suites: [{
          name: 'Fake Suite',
          description: 'Things & stuff',
          commands: [{ name: 'send message', description: 'Send a message', direct_parameter: 'text', parameters: ['to: text', 'urgent: boolean (optional)'], result: 'boolean' }],
          classes: [{ name: 'message', description: 'A message', inherits: 'item', plural: 'messages', properties: ['subject: text (read-only)', 'recipients: list of text'], elements: ['attachment'], responds_to: ['send message'] }],
          class_extensions: [{ name: 'application', properties: ['unread count: integer (read-only)'], elements: ['message'] }],
          enumerations: [{ name: 'priority', values: ['low', 'high'] }],
        }],
      },
    })
    expect(jxa).toHaveBeenCalledWith(expect.stringContaining('OSACopyScriptingDefinitionFromURL'), { path: app }, expect.objectContaining({ app: 'Fake' }))
    // ❌ 调 /usr/bin/sdef(要装 Xcode)。
    expect(exec.mock.calls.some(([f]) => String(f).endsWith('/sdef'))).toBe(false)
    const xml = await run(p, 'sdef.get', { app, format: 'xml' })
    expect(xml).toMatchObject({ ok: true, data: { format: 'xml', content: expect.stringContaining('<class name="message"') } })
  })

  it('不可脚本化的 App、找不到的 App:说清', async () => {
    const plain = fakeApp('Plain')
    const { p } = setup(table({ "/usr/bin/mdfind kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == 'GuguNoSuchApp7199.app'c": '' }), [], dictionary(null))
    expect(await run(p, 'sdef.get', { app: plain })).toMatchObject({ ok: false, code: 'execution_failed', message: expect.stringContaining('not AppleScript-scriptable') })
    expect(await run(p, 'sdef.get', { app: 'GuguNoSuchApp7199' })).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('system.apps.list') })
    expect(await run(p, 'sdef.get', { app: '/etc/hosts' })).toMatchObject({ ok: false, code: 'invalid_args' })
    expect(await p.provider.preflight!('sdef.get', { app: 'Mail', format: 'dts' })).toMatchObject({ code: 'invalid_args' })
  })

  it('不在常见位置的 App 按名字问 Spotlight', async () => {
    const app = fakeApp('GuguFake7199')
    const { p } = setup(table({ "/usr/bin/mdfind kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == 'GuguFake7199.app'c": `${app}\n` }), [], dictionary(SDEF))
    expect(await run(p, 'sdef.get', { app: 'GuguFake7199' })).toMatchObject({ ok: true, data: { path: app, suites: [{ name: 'Fake Suite' }] } })
  })

  const COCOA = '/System/Library/ScriptingDefinitions/CocoaStandard.sdef'
  const FAKE_SUITE = SDEF.slice(SDEF.indexOf('<suite name="Fake Suite"'), SDEF.indexOf('</dictionary>'))
  it.runIf(fs.existsSync(COCOA))('系统标准 suite 的 xi:include 接进来:整个 suite / 只接里面并去掉点名的(只认系统那个目录)', async () => {
    const app = fakeApp('Std')
    const whole = `<dictionary><xi:include href="file://localhost${COCOA}" xpointer="xpointer(/dictionary/suite)"/><xi:include href="file://localhost/etc/passwd"/>${FAKE_SUITE}</dictionary>`
    const a = setup(table({}), [], dictionary(whole))
    const r = await run(a.p, 'sdef.get', { app })
    expect(r.ok ? (r.data as { suites: Array<{ name: string }> }).suites.map((s) => s.name) : r).toEqual(['Standard Suite', 'Fake Suite'])
    // Mail 的写法:App 自己的 Standard Suite 里接系统那份的内容,去掉它自己重写的几个命令。
    const inner = `<dictionary><suite name="Standard Suite" code="????"><xi:include href="file://localhost${COCOA}" xpointer="xpointer(/dictionary/suite/node()[not(self::command and ((@name = 'delete') or (@name = 'duplicate')))])"/><command name="delete" code="coredelo" description="Mail's own delete"/></suite></dictionary>`
    const b = setup(table({}), [], dictionary(inner))
    const m = await run(b.p, 'sdef.get', { app })
    const suites = m.ok ? (m.data as { suites: Array<{ name: string; commands: Array<{ name: string; description: string }> }> }).suites : []
    expect(suites.map((s) => s.name)).toEqual(['Standard Suite'])
    const commands = suites[0]!.commands
    expect(commands.filter((c) => c.name === 'delete')).toEqual([{ name: 'delete', description: "Mail's own delete" }])
    expect(commands.some((c) => c.name === 'duplicate')).toBe(false)
    expect(commands.some((c) => c.name === 'open')).toBe(true)
  })
})

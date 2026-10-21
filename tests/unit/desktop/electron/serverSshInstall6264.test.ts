// #6264「从桌面用 SSH 一步装好」(product spec):地址解析、ssh 配置、提问识别、参数与脚本拼装、输出解读、五步状态机。
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildForwardSshArgs,
  buildSshArgs,
  changedHostKey,
  classifyInstallFailure,
  classifySshFailure,
  describePrompt,
  installedProtocolUnreadable,
  installedServerTooOld,
  installFromUploadScript,
  installScript,
  isNoInternet,
  isSafeSshOptionList,
  loginScript,
  logLines,
  machineNameFromTarget,
  manifestUrl,
  NO_INTERNET_EXIT,
  NO_INTERNET_MARK,
  oneLineInstallCommand,
  installScriptUrl,
  parseDownloadProgress,
  parseLoginOutput,
  parseProbeOutput,
  parseSshCommand,
  parseSshConfigHosts,
  parseSshTarget,
  PROBE_BEGIN,
  PROBE_END,
  probeScript,
  serviceWarnings,
  unsupportedPlatform,
  UPLOAD_FILE,
  type ProbeResult,
} from '../../../../apps/desktop/electron/server/ssh-install/logic'
import { quoteShellArg as shQuote } from '../../../../apps/desktop/electron/session/main/utils/shellEscape'
import { downloadServerOnDesktop } from '../../../../apps/desktop/electron/server/ssh-install/desktop-download'
import {
  hostForKnownHosts,
  InstallRun,
  runSshInstall,
  type SpawnSsh,
  type SshInstallDeps,
  type SshRunResult,
} from '../../../../apps/desktop/electron/server/ssh-install/runner'
import { readSshConfigHosts } from '../../../../apps/desktop/electron/server/ssh-install/ssh-config-hosts'
import { parseSshMachines } from '../../../../apps/desktop/electron/server/ssh-machines'
import type { ServerSshInstallState } from '../../../../apps/desktop/src/lib/serverSshInstall'
import { MIN_SERVER_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '../../../../packages/core/src/cloud/serverMachineHealth'

const INSTALL_SH = path.resolve(__dirname, '../../../../scripts/gugu-server/install.sh')

/** 把脚本写进文件再 `sh 文件` 跑(❌ spawnSync 的 input:macOS 上会间歇性挂死,#3766)。 */
function runScript(script: string, env: NodeJS.ProcessEnv, extraArgs: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-script-'))
  const file = path.join(dir, 'script.sh')
  fs.writeFileSync(file, script)
  try {
    return spawnSync('sh', [...extraArgs, file], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('parseSshTarget / parseSshCommand', () => {
  it.each([
    ['myserver', { destination: 'myserver', port: undefined, display: 'myserver' }],
    ['alice@10.0.0.5', { destination: 'alice@10.0.0.5', port: undefined, display: 'alice@10.0.0.5' }],
    ['alice@host.example.com:2222', { destination: 'alice@host.example.com', port: 2222, display: 'alice@host.example.com:2222' }],
    ['ssh://bob@box:22', { destination: 'bob@box', port: 22, display: 'bob@box:22' }],
    ['ssh -p 2200 bob@box', { destination: 'bob@box', port: 2200, display: 'bob@box:2200' }],
    ['root@[::1]:2222', { destination: 'root@::1', port: 2222, display: 'root@[::1]:2222' }],
    ['  lab-gpu  ', { destination: 'lab-gpu', port: undefined, display: 'lab-gpu' }],
  ])('认得 %s', (input, expected) => {
    expect(parseSshTarget(input)).toEqual(expected)
  })

  it('整条 ssh 命令:端口、用户、密钥、跳板、-o 选项都认,连接无关的丢掉', () => {
    expect(parseSshCommand('ssh -p 2222 -i "~/My Keys/id_ed25519" -J jump@bastion:22 -o IdentitiesOnly=yes -o "ServerAliveInterval 30" -4 -L 8080:localhost:80 -tt alice@10.0.0.5')).toEqual({
      destination: 'alice@10.0.0.5',
      port: 2222,
      display: 'alice@10.0.0.5:2222',
      options: ['-i', '~/My Keys/id_ed25519', '-J', 'jump@bastion:22', '-o', 'IdentitiesOnly=yes', '-o', 'ServerAliveInterval=30', '-4'],
    })
    expect(parseSshCommand('ssh -l bob -oPort=2201 box')).toEqual({ destination: 'bob@box', port: 2201, display: 'bob@box:2201' })
    expect(parseSshCommand('ssh -p2201 -i~/.ssh/k box')).toMatchObject({ port: 2201, options: ['-i', '~/.ssh/k'] })
  })

  it('能在本机执行命令的选项一律拒绝,并说出是哪一个', () => {
    expect(parseSshCommand('ssh -o ProxyCommand="nc %h %p" box')).toEqual({ problem: 'unsupportedOption', option: 'ProxyCommand' })
    expect(parseSshCommand('ssh -oLocalCommand=touch box')).toEqual({ problem: 'unsupportedOption', option: 'LocalCommand' })
    expect(parseSshCommand('ssh -F /tmp/evil box')).toEqual({ problem: 'unsupportedOption', option: '-F' })
    expect(parseSshCommand('ssh -P box')).toEqual({ problem: 'unsupportedOption', option: '-P' })
  })

  it('带了要执行的命令:说清只填连接部分', () => {
    expect(parseSshCommand('ssh alice@box uptime')).toEqual({ problem: 'command' })
    expect(parseSshCommand('ssh -- alice@box ls -la')).toEqual({ problem: 'command' })
  })

  it.each([
    '',
    '-oProxyCommand=touch /tmp/pwned',
    'alice@-oProxyCommand=x',
    'host; rm -rf ~',
    'alice@host:99999',
    'alice@host:0',
    'al ice@host',
    '$(whoami)@host',
    'host\nother',
    '`id`',
    'ssh -p',
    'ssh -J "-oProxyCommand=x" box',
    'ssh "unterminated',
  ])('拒绝 %j —— 不能变成 ssh 的选项或 shell 片段', (input) => {
    expect(parseSshTarget(input)).toBeNull()
  })

  it('存过盘的连接选项再过一遍白名单', () => {
    expect(isSafeSshOptionList(['-i', '~/.ssh/k', '-J', 'jump', '-o', 'IdentitiesOnly=yes', '-4'])).toBe(true)
    expect(isSafeSshOptionList(['-o', 'ProxyCommand=nc x'])).toBe(false)
    expect(isSafeSshOptionList(['-o', 'proxyjump=x'])).toBe(false)
    expect(isSafeSshOptionList(['-F', '/tmp/x'])).toBe(false)
    expect(isSafeSshOptionList(['-i'])).toBe(false)
    expect(parseSshMachines(JSON.stringify({ machines: [
      { deviceId: 'd1', ownerUserId: 'u1', destination: 'a@b', display: 'a@b', addedAt: 'x', options: ['-J', 'jump'] },
      { deviceId: 'd2', ownerUserId: 'u1', destination: 'a@b', display: 'a@b', addedAt: 'x', options: ['-o', 'ProxyCommand=sh'] },
    ] })).map((m) => m.deviceId)).toEqual(['d1'])
  })
})

describe('parseSshConfigHosts', () => {
  it('列出具体别名,跳过通配与 Match 块,每个关键字只认第一次', () => {
    const hosts = parseSshConfigHosts(`
# 注释
Host *
  User everyone
Host gpu gpu-alias
  HostName 10.1.2.3
  User alice
  Port 2222
  Port 3333
Host "quoted host" !negated
  hostname=example.com
Match host gpu
  User shouldnotapply
Host web-*
  User nope
Host gpu
  User duplicate
`)
    expect(hosts).toEqual([
      { alias: 'gpu', hostname: '10.1.2.3', user: 'alice', port: 2222 },
      { alias: 'gpu-alias', hostname: '10.1.2.3', user: 'alice', port: 2222 },
      { alias: 'quoted host', hostname: 'example.com' },
    ])
  })

  it('跟随 Include(相对 ~/.ssh、最后一段通配)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-sshcfg-'))
    try {
      fs.mkdirSync(path.join(dir, 'config.d'))
      fs.writeFileSync(path.join(dir, 'config'), 'Include config.d/*\nHost main\n  HostName m.example\n')
      fs.writeFileSync(path.join(dir, 'config.d', 'a'), 'Host from-include\n  User bob\n')
      fs.writeFileSync(path.join(dir, 'config.d', 'loop'), `Include ${path.join(dir, 'config')}\n`)
      expect(readSshConfigHosts(path.join(dir, 'config')).map((h) => h.alias)).toEqual(['from-include', 'main'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildSshArgs', () => {
  it('目的地放在 -- 之后,远端命令只有 sh -s;复用连接;打开认证日志;❌ 关指纹检查', () => {
    const args = buildSshArgs({ destination: 'alice@box', port: 2222, display: '' }, { controlPath: '/tmp/x/cm-%C' })
    expect(args.slice(-4)).toEqual(['--', 'alice@box', 'sh', '-s'])
    expect(args).toContain('ControlPath=/tmp/x/cm-%C')
    expect(args).toContain('LogLevel=VERBOSE')
    expect(args.join(' ')).toContain('-p 2222')
    expect(args.join(' ')).not.toMatch(/StrictHostKeyChecking|BatchMode=yes|UserKnownHostsFile=\/dev\/null/)
  })

  it('整条命令带来的选项放在目的地之前;上传时远端命令换成 cat > 文件', () => {
    const target = { destination: 'b', display: 'b', options: ['-J', 'jump', '-i', '/k'] }
    const args = buildSshArgs(target, { controlPath: null, remoteCommand: `cat > ${UPLOAD_FILE}` })
    expect(args.slice(-7)).toEqual(['-J', 'jump', '-i', '/k', '--', 'b', `cat > ${UPLOAD_FILE}`])
    expect(args[args.length - 1]).toBe(`cat > ${UPLOAD_FILE}`)
    // 端口转发同样带上
    const forward = buildForwardSshArgs(target, { localPort: 4000, remotePort: 3000 })
    expect(forward.indexOf('-J')).toBeLessThan(forward.indexOf('--'))
  })

  it('Windows(没有 controlPath)不开 ControlMaster', () => {
    expect(buildSshArgs({ destination: 'h', display: 'h' }, { controlPath: null }).join(' ')).not.toContain('ControlMaster')
  })

  it('known_hosts 里的写法:非 22 端口带方括号', () => {
    expect(hostForKnownHosts({ destination: 'alice@10.0.0.5', port: 2222, display: '' })).toBe('[10.0.0.5]:2222')
    expect(hostForKnownHosts({ destination: 'box', display: '' })).toBe('box')
  })
})

describe('describePrompt:SSH 在问什么', () => {
  it('新主机指纹(OpenSSH 10 的「is:」写法)拆成主机、类型、指纹', () => {
    const message = [
      "The authenticity of host '[127.0.0.1]:38924 ([127.0.0.1]:38924)' can't be established.",
      'ED25519 key fingerprint is: SHA256:o5ek7N2SRM/+USAsCtScLirZ/CfmiYuTlj+t8cCRlCE',
      'This key is not known by any other names.',
      'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
    ].join('\n')
    expect(describePrompt(message)).toMatchObject({
      kind: 'hostKey',
      hostKey: { host: '[127.0.0.1]:38924', keyType: 'ED25519', fingerprint: 'SHA256:o5ek7N2SRM/+USAsCtScLirZ/CfmiYuTlj+t8cCRlCE' },
    })
    // 老版本句末带句号
    expect(describePrompt("The authenticity of host 'box (1.2.3.4)' can't be established.\nECDSA key fingerprint is SHA256:abc+/=.\nAre you sure you want to continue connecting (yes/no)? ").hostKey)
      .toEqual({ host: 'box', keyType: 'ECDSA', fingerprint: 'SHA256:abc+/=' })
  })

  it("ssh 追问「Please type 'yes', 'no'…」仍是指纹确认,❌ 当成密码框", () => {
    expect(describePrompt("Please type 'yes', 'no' or the fingerprint: ").kind).toBe('hostKey')
  })

  it('密码、键盘交互密码、密钥口令、二次验证码、只提醒的安全密钥', () => {
    expect(describePrompt("alice@box's password: ")).toMatchObject({ kind: 'password', subject: 'alice@box' })
    expect(describePrompt('(alice@box) Password: ')).toMatchObject({ kind: 'password', subject: 'alice@box' })
    expect(describePrompt('Password: ')).toMatchObject({ kind: 'password' })
    expect(describePrompt("Enter passphrase for key '/Users/a/.ssh/id_ed25519': ", '', '/Users/a')).toMatchObject({ kind: 'passphrase', subject: '~/.ssh/id_ed25519' })
    expect(describePrompt('(alice@box) Verification code: ')).toMatchObject({ kind: 'otp', label: '(alice@box) Verification code:' })
    expect(describePrompt('Confirm user presence for key ED25519-SK SHA256:xyz', 'none')).toMatchObject({ kind: 'notice', label: 'Confirm user presence for key ED25519-SK SHA256:xyz' })
  })
})

describe('远端脚本', () => {
  it('shQuote 经真 sh 往返不变', () => {
    for (const value of ["it's", 'a"b', '$(id)', '`x`', 'a\\nb', "''", 'https://x/y?a=1&b=2']) {
      expect(execFileSync('sh', ['-c', `printf '%s' ${shQuote(value)}`]).toString()).toBe(value)
    }
  })

  it('loginScript 只收 base64url,凭证只在脚本(标准输入)里、经内建 printf 递出', () => {
    const script = loginScript('abcDEF0123456789_-xyz')
    expect(script).toContain(`printf '%s\\n' 'abcDEF0123456789_-xyz' |`)
    expect(script).toContain('login --grant-stdin')
    expect(() => loginScript("abc'; rm -rf ~; echo '0123456789")).toThrow()
    expect(() => loginScript('short')).toThrow()
  })

  it('默认名照 VS Code Remote-SSH:别名就叫别名,用户@主机叫主机,主机是 IP 不给名字(库里退回 Linux N)', () => {
    expect(machineNameFromTarget({ destination: 'd22' })).toBe('d22')
    expect(machineNameFromTarget({ destination: 'root@gpu-box.lab' })).toBe('gpu-box.lab')
    expect(machineNameFromTarget({ destination: 'root@203.0.113.47' })).toBeNull()
    expect(machineNameFromTarget({ destination: 'root@::1' })).toBeNull()
    expect(loginScript('abcDEF0123456789_-xyz', 'd22')).toContain("login --grant-stdin --name 'd22'\n")
    expect(loginScript('abcDEF0123456789_-xyz', null)).toContain('login --grant-stdin\n')
    // 不是 HOST_RE 认的字符:不拼进脚本(❌ 靠引号兜底)
    expect(loginScript('abcDEF0123456789_-xyz', "x'; id; '")).not.toContain('--name')
  })

  it('loginScript 真跑一遍:gugu-server 从标准输入读到凭证,命令行参数里没有', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-login-'))
    try {
      fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true })
      const fake = path.join(home, '.local', 'bin', 'gugu-server')
      fs.writeFileSync(fake, '#!/bin/sh\necho "args=$*"\nread -r line\necho "stdin=$line"\n', { mode: 0o755 })
      const script = path.join(home, 'login.sh')
      fs.writeFileSync(script, loginScript('Zm9vYmFyYmF6cXV4MTIzNDU2'))
      const out = execFileSync('sh', [script], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
      expect(out).toContain('args=login --grant-stdin')
      expect(out).toContain('stdin=Zm9vYmFyYmF6cXV4MTIzNDU2')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('probeScript 真跑一遍:读出系统、空间、能不能写能不能执行、已登着的账号', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-probe-'))
    try {
      const account = path.join(home, '.gugu-server', 'accounts', 'u-other', 'data')
      fs.mkdirSync(account, { recursive: true })
      fs.writeFileSync(path.join(account, 'server-session.enc'), 'x')
      fs.writeFileSync(path.join(home, '.gugu-server', 'accounts', 'u-other', 'account.json'), JSON.stringify({ userId: 'u-other', email: 'colleague@lab.edu' }, null, 2))
      fs.mkdirSync(path.join(home, '.gugu-server', 'accounts', 'u-signed-out'), { recursive: true })
      const out = runScript(probeScript(), { ...process.env, HOME: home, GUGU_SERVER_HOME: '' }).stdout
      const probe = parseProbeOutput(out)!
      expect(probe.os).toBe(os.platform() === 'darwin' ? 'Darwin' : 'Linux')
      expect(probe.writable).toBe(true)
      expect(probe.exec).toBe(true)
      expect(probe.freeKb).toBeGreaterThan(0)
      expect(probe.accounts).toEqual([{ userId: 'u-other', email: 'colleague@lab.edu' }])
      expect(fs.readdirSync(home).filter((name) => name.startsWith('.gugu-exec-test'))).toEqual([])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('probeScript 真跑一遍:装着的 gugu-server 报协议 / 明确不认 protocol / 崩了 / 没权限,各归各类', () => {
    const cases: Array<[string, Partial<ProbeResult>]> = [
      // 前面有告警行也读得出(标准错误合在一起)。
      ['echo "warning: something" >&2; echo 2', { installedProtocol: 2, protocolCheck: 'ok' }],
      // 与 server-entry.ts 的 default 分支同形:退出码 2 + 「不认识的命令:protocol」+ 用法。
      [`echo "不认识的命令:$1" >&2; echo "用法:gugu-server <命令>" >&2; exit 2`, { installedProtocol: null, protocolCheck: 'unknownCommand' }],
      // 退出码 2 但不是「不认识」(比如参数错):❌ 版本信号。
      ['echo "用法错" >&2; exit 2', { protocolCheck: 'failed' }],
      ['echo "Segmentation fault" >&2; exit 139', { protocolCheck: 'failed', protocolError: 'exit 139: Segmentation fault' }],
      ['echo "Permission denied" >&2; exit 126', { protocolCheck: 'failed', protocolError: 'exit 126: Permission denied' }],
    ]
    for (const [body, expected] of cases) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-probe-'))
      try {
        fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true })
        fs.mkdirSync(path.join(home, '.gugu-server', 'current'), { recursive: true })
        fs.writeFileSync(path.join(home, '.gugu-server', 'current', 'version'), '0.2.160')
        const bin = path.join(home, '.local', 'bin', 'gugu-server')
        fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = help ]; then echo "--grant-stdin"; exit 0; fi\n${body}\n`)
        fs.chmodSync(bin, 0o755)
        const probe = parseProbeOutput(runScript(probeScript(), { ...process.env, HOME: home, GUGU_SERVER_HOME: '' }).stdout)!
        expect(probe, body).toMatchObject({ installedVersion: '0.2.160', ...expected })
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
      }
    }
  })

  it('installScript 与 installFromUploadScript 都是合法的 sh;下载根只在指定时带过去', () => {
    const plain = installScript({ installUrl: 'https://d/x/install.sh', manifestUrl: 'https://d/x/stable/linux-x64.txt', channel: 'stable', downloadBase: null })
    expect(plain).toContain("U='https://d/x/install.sh'")
    expect(plain).toContain("--channel 'stable' --no-service --no-login")
    expect(plain).not.toContain('GUGU_SERVER_DOWNLOAD_BASE')
    const custom = installScript({ installUrl: 'http://h:1/install.sh', manifestUrl: 'm', channel: 'beta', downloadBase: "http://h:1/it's" })
    expect(custom).toContain(`GUGU_SERVER_DOWNLOAD_BASE='http://h:1/it'\\''s' sh "$T"`)
    const upload = installFromUploadScript({ installSh: '#!/bin/sh\necho hi\n', channel: 'stable', version: '0.2.99', sha256: 'a'.repeat(64) })
    for (const script of [plain, custom, upload]) {
      expect(runScript(script, process.env, ['-n']).status).toBe(0)
    }
    expect(() => installFromUploadScript({ installSh: 'x\n__GUGU_INSTALL_SH_EOF__\n', channel: 'stable', version: '1', sha256: 'a'.repeat(64) })).toThrow()
    expect(() => installFromUploadScript({ installSh: 'x', channel: 'stable', version: '1; rm', sha256: 'a'.repeat(64) })).toThrow()
  })

  it('安装脚本按通道取:Beta 桌面拿 Beta 发的那份,❌ 共用根目录那份(那是正式版的)', () => {
    expect(installScriptUrl('https://d/r/server', 'stable')).toBe('https://d/r/server/stable/install.sh')
    expect(installScriptUrl('https://d/r/server', 'beta')).toBe('https://d/r/server/beta/install.sh')
  })

  it('一行安装命令与 install.sh 抬头写的一致', () => {
    expect(oneLineInstallCommand('https://d/r/server', 'stable')).toBe('curl -fsSL https://d/r/server/install.sh | sh')
    expect(oneLineInstallCommand('https://d/r/server', 'beta')).toBe('curl -fsSL https://d/r/server/install.sh | sh -s -- --channel beta')
    expect(oneLineInstallCommand('https://d/r/server', 'stable', 'wget')).toBe('wget -qO- https://d/r/server/install.sh | sh')
  })
})

// ── 真跑:本机造一个假的下载站(file://)+ 假包,走同一份 install.sh ─────────────────────

function fakeReleaseSite(): { root: string; base: string; version: string; sha256: string; tarball: string; manifest: string; home: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-site-'))
  const version = '9.9.9'
  const osName = os.platform() === 'darwin' ? 'darwin' : 'linux'
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64'
  const stage = path.join(root, 'stage', `gugu-server-${version}-${osName}-${arch}`)
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'bin', 'gugu-server'), '#!/bin/sh\necho "gugu-server help --grant-stdin"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(stage, 'version'), version)
  fs.mkdirSync(path.join(root, version))
  const tarball = path.join(root, version, `gugu-server-${version}-${osName}-${arch}.tar.gz`)
  execFileSync('tar', ['-czf', tarball, '-C', path.dirname(stage), path.basename(stage)])
  const sha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex')
  fs.mkdirSync(path.join(root, 'stable'))
  const manifest = path.join(root, 'stable', `${osName}-${arch}.txt`)
  fs.writeFileSync(manifest, `${version} ${sha256} file://${tarball}\n`)
  fs.copyFileSync(INSTALL_SH, path.join(root, 'install.sh'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  return { root, base: `file://${root}`, version, sha256, tarball, manifest, home }
}

const hasCurl = spawnSync('sh', ['-c', 'command -v curl']).status === 0

describe.skipIf(!hasCurl)('远端脚本真跑(file:// 假下载站)', () => {
  it('能上网:报版本、总量、字节进度,装进 ~/.gugu-server', () => {
    const site = fakeReleaseSite()
    try {
      const script = installScript({ installUrl: `${site.base}/install.sh`, manifestUrl: `file://${site.manifest}`, channel: 'stable', downloadBase: site.base })
      const run = runScript(script, { ...process.env, HOME: site.home, GUGU_SERVER_HOME: '', PATH: process.env.PATH })
      expect(run.status, run.stderr).toBe(0)
      const progress = parseDownloadProgress(run.stdout)
      expect(progress.version).toBe(site.version)
      expect(fs.readFileSync(path.join(site.home, '.gugu-server', 'current', 'version'), 'utf8')).toBe(site.version)
      expect(fs.existsSync(path.join(site.home, '.local', 'bin', 'gugu-server'))).toBe(true)
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true })
    }
  })

  it('连不上下载站:以约定的退出码与标记退出,❌ 在黑洞地址上干等', () => {
    const site = fakeReleaseSite()
    try {
      const script = installScript({ installUrl: `${site.base}/install.sh`, manifestUrl: `file://${site.root}/nope.txt`, channel: 'stable', downloadBase: site.base })
      const run = runScript(script, { ...process.env, HOME: site.home })
      expect(run.status).toBe(NO_INTERNET_EXIT)
      expect(run.stdout).toContain(NO_INTERNET_MARK)
      expect(isNoInternet({ code: run.status, stdout: run.stdout, stderr: run.stderr })).toBe(true)
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true })
    }
  })

  it('本机下载 → 传过去 → 用传过去的包装(同一份 install.sh 的 --package 模式)', () => {
    const site = fakeReleaseSite()
    try {
      fs.copyFileSync(site.tarball, path.join(site.home, UPLOAD_FILE))
      const script = installFromUploadScript({ installSh: fs.readFileSync(INSTALL_SH, 'utf8'), channel: 'stable', version: site.version, sha256: site.sha256 })
      // 没有 curl / wget 也要装得上:PATH 里只留基本工具
      const run = runScript(script, { ...process.env, HOME: site.home, GUGU_SERVER_HOME: '' })
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout).toContain('用传过来的安装包')
      expect(fs.readFileSync(path.join(site.home, '.gugu-server', 'current', 'version'), 'utf8')).toBe(site.version)
      expect(fs.existsSync(path.join(site.home, UPLOAD_FILE))).toBe(false)
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true })
    }
  })

  it('传过来的包校验不对:停下并说「包校验不通过」', () => {
    const site = fakeReleaseSite()
    try {
      fs.copyFileSync(site.tarball, path.join(site.home, UPLOAD_FILE))
      const script = installFromUploadScript({ installSh: fs.readFileSync(INSTALL_SH, 'utf8'), channel: 'stable', version: site.version, sha256: 'b'.repeat(64) })
      const run = runScript(script, { ...process.env, HOME: site.home })
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('包校验不通过')
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true })
    }
  })
})

// ── 真跑:在已装旧版本的机器上重新执行 install.sh(= 急着升级)────────────────────────────
// 实机踩到的坑:`mv -f current.tmp current` 在 current 是指向目录的软链时,GNU / BSD mv 都把 current.tmp 挪进
// versions/<旧版本>/ 里、退出码却是 0 —— current 没切,随后的 `service install` 跑的还是旧版本。

/** 造一个 `--package` 模式能用的包。假 gugu-server 把自己被叫到的命令记进 $HOME/calls.log(带上自己的版本)。 */
function fakePackage(root: string, version: string): { tarball: string; sha256: string } {
  const osName = os.platform() === 'darwin' ? 'darwin' : 'linux'
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64'
  const stage = path.join(root, `stage-${version}`, `gugu-server-${version}-${osName}-${arch}`)
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true })
  fs.writeFileSync(
    path.join(stage, 'bin', 'gugu-server'),
    [
      '#!/bin/sh',
      `echo "${version} $*" >> "$HOME/calls.log"`,
      'case "$1" in',
      `  service) [ -n "$FAKE_SERVICE_FAIL" ] && exit 1; echo "咕咕 server ${version} 已在运行(进程 4242)。" ;;`,
      '  status) echo "登录的账号:无(执行 gugu-server login)" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const tarball = path.join(root, `gugu-server-${version}.tar.gz`)
  execFileSync('tar', ['-czf', tarball, '-C', path.dirname(stage), path.basename(stage)])
  return { tarball, sha256: createHash('sha256').update(fs.readFileSync(tarball)).digest('hex') }
}

const nativeMv = execFileSync('sh', ['-c', 'command -v mv']).toString().trim()
/** 本机 mv「把目标当普通文件整个替换」的写法:macOS 是 -h,GNU 是 -T。 */
const noFollowFlag = os.platform() === 'darwin' ? '-hf' : '-Tf'

/**
 * 在 PATH 最前面放一个假 mv,模拟三种 mv:只认 -T 的(GNU)、只认 -h 的(BSD/macOS)、两个都不认的(busybox 老版本)。
 * 不带这两个选项时交给本机 mv —— 它会照「挪进目录」那个坑走,正好是要防的行为。
 */
function mvShim(root: string, kind: 'gnu' | 'bsd' | 'neither'): string {
  const dir = path.join(root, `mv-${kind}`)
  fs.mkdirSync(dir)
  const accepts = (flag: 'T' | 'h') => (kind === 'gnu' && flag === 'T') || (kind === 'bsd' && flag === 'h')
  const branch = (flag: 'T' | 'h') =>
    accepts(flag)
      ? `  -${flag}*) shift; exec ${nativeMv} ${noFollowFlag} "$@" ;;`
      : `  -${flag}*) echo "mv: invalid option -- '${flag}'" >&2; exit 1 ;;`
  fs.writeFileSync(
    path.join(dir, 'mv'),
    ['#!/bin/sh', 'case "$1" in', branch('T'), branch('h'), 'esac', `exec ${nativeMv} "$@"`, ''].join('\n'),
    { mode: 0o755 },
  )
  return dir
}

const shells = ['sh', ...(fs.existsSync('/bin/dash') ? ['/bin/dash'] : [])]

describe('重新执行安装命令升级(install.sh --package 真跑)', () => {
  const install = (
    shell: string,
    home: string,
    pkg: { tarball: string; sha256: string },
    version: string,
    extraPath: string | null,
    env: NodeJS.ProcessEnv = {},
  ) =>
    spawnSync(shell, [INSTALL_SH, '--package', pkg.tarball, '--version', version, '--sha256', pkg.sha256], {
      env: { ...process.env, HOME: home, GUGU_SERVER_HOME: '', PATH: `${extraPath ? `${extraPath}:` : ''}${process.env.PATH}`, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  for (const shell of shells) {
    for (const mv of ['native', 'gnu', 'bsd', 'neither'] as const) {
      it(`${shell} + ${mv} mv:current 切到新版本,常驻服务由新版本注册,旧脚本留下的 current.tmp 清掉`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-upgrade-'))
        try {
          const home = path.join(root, 'home')
          fs.mkdirSync(home)
          const shim = mv === 'native' ? null : mvShim(root, mv)
          const oldPkg = fakePackage(root, '0.2.111')
          const newPkg = fakePackage(root, '0.2.112')
          const serverHome = path.join(home, '.gugu-server')

          const first = install(shell, home, oldPkg, '0.2.111', shim)
          expect(first.status, first.stderr).toBe(0)
          expect(fs.readlinkSync(path.join(serverHome, 'current'))).toBe('versions/0.2.111')
          // 旧安装脚本踩坑时留下的
          fs.symlinkSync('versions/0.2.112', path.join(serverHome, 'versions', '0.2.111', 'current.tmp'))
          fs.rmSync(path.join(home, 'calls.log'))

          const second = install(shell, home, newPkg, '0.2.112', shim)
          expect(second.status, second.stderr).toBe(0)
          expect(fs.readlinkSync(path.join(serverHome, 'current'))).toBe('versions/0.2.112')
          expect(fs.existsSync(path.join(serverHome, 'current.tmp'))).toBe(false)
          expect(fs.readdirSync(path.join(serverHome, 'versions', '0.2.111'))).not.toContain('current.tmp')
          const calls = fs.readFileSync(path.join(home, 'calls.log'), 'utf8').trim().split('\n')
          // 注册常驻 / 换掉在跑的那个,是新版本自己做的
          expect(calls).toContain('0.2.112 service install')
          expect(calls.some((line) => line.startsWith('0.2.111 '))).toBe(false)
          expect(second.stdout).toContain('已安装咕咕 server 0.2.112')
          expect(second.stdout).toContain('咕咕 server 0.2.112 已在运行')
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      })
    }
  }

  it('没有账号登录时真的去登录(❌ 说「已经登录过」);新版本没跑起来时不报成功,说清再执行什么', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-upgrade-'))
    try {
      const home = path.join(root, 'home')
      fs.mkdirSync(home)
      const pkg = fakePackage(root, '0.2.112')
      const ok = install('sh', home, pkg, '0.2.112', null)
      expect(ok.status, ok.stderr).toBe(0)
      expect(ok.stdout).not.toContain('已经登录过')
      expect(fs.readFileSync(path.join(home, 'calls.log'), 'utf8')).toContain('0.2.112 login')

      const failed = install('sh', home, pkg, '0.2.112', null, { FAKE_SERVICE_FAIL: '1' })
      expect(failed.stdout).toContain('server 未能以 0.2.112 启动')
      expect(failed.stdout).toContain('service install')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('本机下载(那台机器上不了网时)', () => {
  const body = Buffer.from('fake-package-bytes')
  const sha = createHash('sha256').update(body).digest('hex')
  const fakeFetch = (files: Record<string, Buffer | string>) => async (url: string) => {
    const hit = files[url]
    if (hit === undefined) return new Response('nope', { status: 404 })
    return new Response(typeof hit === 'string' ? hit : new Uint8Array(hit), { status: 200, headers: { 'content-length': String(Buffer.byteLength(hit)) } })
  }

  it('取清单 → 取 install.sh → 下包、边下边报字节、校验通过', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-dl-'))
    const progress: Array<[number, number | null]> = []
    try {
      const pkg = await downloadServerOnDesktop({
        manifestUrl: 'https://d/stable/linux-x64.txt',
        installUrl: 'https://d/install.sh',
        dir,
        signal: new AbortController().signal,
        onProgress: (done, total) => progress.push([done, total]),
        fetch: fakeFetch({ 'https://d/stable/linux-x64.txt': `0.2.99 ${sha} https://d/p.tgz\n`, 'https://d/install.sh': '#!/bin/sh\n', 'https://d/p.tgz': body }),
      })
      expect(pkg).toMatchObject({ version: '0.2.99', sha256: sha, size: body.length, installSh: '#!/bin/sh\n' })
      expect(fs.readFileSync(pkg.file)).toEqual(body)
      expect(progress[progress.length - 1]).toEqual([body.length, body.length])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('校验不对就丢掉并报错', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-dl-'))
    try {
      await expect(downloadServerOnDesktop({
        manifestUrl: 'm', installUrl: 'i', dir, signal: new AbortController().signal, onProgress: () => undefined,
        fetch: fakeFetch({ m: `0.2.99 ${'c'.repeat(64)} p`, i: '#!/bin/sh\n', p: body }),
      })).rejects.toThrow(/校验不通过/)
      expect(fs.readdirSync(dir)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('读远端输出', () => {
  const probeLines = (extra: string[]) => `welcome!\nos=Windows\n${PROBE_BEGIN}\nos=Linux\narch=aarch64\nuser=alice\nhostname=ip-172-31-1-2\n${extra.join('\n')}\n${PROBE_END}\n`

  it('parseProbeOutput 只读标记之间,.bashrc 的噪音混不进来', () => {
    const out = probeLines(['distro=Ubuntu 22.04.4 LTS', 'libc=glibc 2.35', 'installed=0.2.49', 'grant=1', 'running=1', 'account=u1 a@b.c', 'account=u2 ', 'fetcher=curl', 'freekb=1048576', 'exec=1'])
    expect(parseProbeOutput(out)).toEqual({
      os: 'Linux', arch: 'aarch64', user: 'alice', hostname: 'ip-172-31-1-2', distro: 'Ubuntu 22.04.4 LTS', libc: 'glibc 2.35',
      installedVersion: '0.2.49', supportsGrant: true, supportsMatch: false, installedProtocol: null, protocolCheck: 'failed', protocolError: 'exit ?:', running: true, fetcher: 'curl', freeKb: 1048576, writable: true, exec: true,
      accounts: [{ userId: 'u1', email: 'a@b.c' }, { userId: 'u2', email: null }],
    })
    expect(parseProbeOutput('no markers')).toBeNull()
    // 装着的那份说得出协议版本才有数;不认这条命令(打空行)/ 形状不对 = null。
    expect(parseProbeOutput(probeLines(['installed=0.2.160', 'protocol_exit=0', 'protocol=2']))).toMatchObject({ installedProtocol: 2, protocolCheck: 'ok' })
    // 老版本明确不认这条命令(退出码 2 + 「不认识的命令」)= 版本信号。
    expect(
      parseProbeOutput(probeLines(['installed=0.2.131', 'protocol_exit=2', 'protocol_unknown=1', 'protocol_err=用法']))
    ).toMatchObject({ installedProtocol: null, protocolCheck: 'unknownCommand', protocolError: null })
    // 崩溃 / 超时 / 没权限 / 答非所问 = 失败,❌ 版本信号。
    expect(parseProbeOutput(probeLines(['installed=0.2.160', 'protocol_exit=139', 'protocol_err=Segmentation fault']))).toMatchObject({
      installedProtocol: null,
      protocolCheck: 'failed',
      protocolError: 'exit 139: Segmentation fault',
    })
    expect(parseProbeOutput(probeLines(['installed=0.2.160', 'protocol_exit=124', 'protocol_err=']))?.protocolCheck).toBe('failed')
    expect(parseProbeOutput(probeLines(['installed=0.2.160', 'protocol_exit=0', 'protocol=']))?.protocolCheck).toBe('failed')
    expect(parseProbeOutput(probeLines([]))?.protocolCheck).toBeNull()
  })

  it('installedServerTooOld:只认明确的版本信号(不认 protocol 命令 / 协议号低于要求);命令失败 ❌ 算太旧、另报失败', () => {
    expect(installedServerTooOld({ installedVersion: '0.2.131', installedProtocol: null, protocolCheck: 'unknownCommand' })).toBe(true)
    expect(installedServerTooOld({ installedVersion: 'unknown', installedProtocol: null, protocolCheck: 'unknownCommand' })).toBe(true)
    expect(installedServerTooOld({ installedVersion: '0.2.160', installedProtocol: REMOTE_PROTOCOL_VERSION, protocolCheck: 'ok' })).toBe(false)
    expect(installedServerTooOld({ installedVersion: '0.2.160', installedProtocol: MIN_SERVER_PROTOCOL - 1, protocolCheck: 'ok' })).toBe(true)
    expect(installedServerTooOld({ installedVersion: null, installedProtocol: null, protocolCheck: null })).toBe(false)
    // 升级只能是因为版本问题:那条命令崩了 / 超时 / 没权限 ⇒ 不算太旧,而是照实报「读不出版本」。
    expect(installedServerTooOld({ installedVersion: '0.2.160', installedProtocol: null, protocolCheck: 'failed' })).toBe(false)
    expect(installedProtocolUnreadable({ installedVersion: '0.2.160', protocolCheck: 'failed' })).toBe(true)
    expect(installedProtocolUnreadable({ installedVersion: '0.2.131', protocolCheck: 'unknownCommand' })).toBe(false)
    expect(installedProtocolUnreadable({ installedVersion: null, protocolCheck: null })).toBe(false)
  })

  it('unsupportedPlatform:系统、架构、musl、老 glibc、家目录不可写、noexec', () => {
    const base = parseProbeOutput(probeLines(['libc=glibc 2.35', 'exec=1']))!
    const w = (patch: Partial<ProbeResult>) => unsupportedPlatform({ ...base, ...patch })
    expect(w({})).toBeNull()
    expect(w({ os: 'FreeBSD' })).toBe('unsupportedOs')
    expect(w({ arch: 'i686' })).toBe('unsupportedArch')
    expect(w({ libc: 'musl' })).toBe('unsupportedLibc')
    expect(w({ libc: 'glibc 2.17' })).toBe('unsupportedLibc')
    expect(w({ libc: 'glibc 2.28' })).toBeNull()
    expect(w({ writable: false })).toBe('noPermission')
    expect(w({ exec: false })).toBe('noExec')
    expect(w({ os: 'Darwin', libc: '' })).toBeNull()
  })

  it.each([
    ['alice@box: Permission denied (publickey,password).', 'authFailed'],
    ['ssh: Could not resolve hostname nope: nodename nor servname provided', 'hostUnresolved'],
    ['ssh: connect to host box port 22: Connection refused', 'connectionRefused'],
    ['kex_exchange_identification: Connection closed by remote host\nConnection closed by 10.255.255.1 port 22', 'connectionRefused'],
    ['ssh: connect to host box port 22: Operation timed out', 'timeout'],
    ['Host key verification failed.', 'hostKeyRejected'],
    ['@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.', 'hostKeyChanged'],
    ['ssh: connect to host box port 22: No route to host', 'unreachable'],
    ['something else', 'unknown'],
  ] as const)('classifySshFailure(%j) = %s', (stderr, reason) => {
    expect(classifySshFailure(stderr)).toBe(reason)
  })

  it('指纹变了:读出要删的记录与新指纹', () => {
    const stderr = [
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
      'The fingerprint for the ED25519 key sent by the remote host is',
      'SHA256:NEWfingerPRINT+/abc.',
      'Host key for [127.0.0.1]:38924 has changed and you have requested strict checking.',
    ].join('\n')
    expect(changedHostKey(stderr, 'fallback')).toEqual({ host: '[127.0.0.1]:38924', fingerprint: 'SHA256:NEWfingerPRINT+/abc' })
    expect(changedHostKey('nothing', 'box')).toEqual({ host: 'box', fingerprint: null })
  })

  it('装失败的原因:盘满、没权限、跑不起来', () => {
    expect(classifyInstallFailure('tar: write error: No space left on device')).toBe('diskFull')
    expect(classifyInstallFailure('mkdir: /home/x/.gugu-server: Permission denied')).toBe('noPermission')
    expect(classifyInstallFailure('安装失败:这个包在本机跑不起来(系统太旧或架构不符)')).toBe('noExec')
    expect(classifyInstallFailure('安装失败:包校验不通过')).toBe('installFailed')
  })

  it('下载进度行 → 版本 / 总量 / 字节;进日志时滤掉机器可读行与流量统计', () => {
    expect(parseDownloadProgress(`__GUGU_MANIFEST__ 0.2.99 abc https://x\n__GUGU_TOTAL__ 110443427\n__GUGU_BYTES__ 1024\n__GUGU_BYTES__ 2048\n`)).toEqual({ version: '0.2.99', total: 110443427, done: 2048 })
    expect(logLines('__GUGU_BYTES__ 1\n__GUGU_ALIVE__\nTransferred: sent 1, received 2 bytes\n正在下载咕咕 server 0.2.99 …\n')).toEqual(['正在下载咕咕 server 0.2.99 …'])
  })

  it('serviceWarnings 把「还差一步」翻成桌面自己的提示', () => {
    expect(serviceWarnings('已注册…\n⚠ 还差一步:…\n  请让管理员执行一次:sudo loginctl enable-linger alice\n')).toEqual([{ kind: 'lingerMissing', user: 'alice' }])
    expect(serviceWarnings('⚠ 这台机器没有可用的 crontab,重启后不会自动启动')).toEqual([{ kind: 'noReboot' }])
    expect(serviceWarnings('已注册为 systemd 用户服务\nSSH 断开后继续运行、机器重启后自动启动。')).toEqual([])
  })

  it('parseLoginOutput 读标记行', () => {
    expect(parseLoginOutput('x\n__GUGU_LOGIN_RESULT__{"userId":"u1","email":"a@b.c","others":["o@p.q"]}\n已登录')).toEqual({
      ok: true, userId: 'u1', email: 'a@b.c', others: ['o@p.q'], deviceId: null,
    })
    expect(parseLoginOutput('__GUGU_LOGIN_RESULT__{"userId":"u1","email":null,"others":[],"deviceId":"d-1"}')).toMatchObject({ deviceId: 'd-1' })
    expect(parseLoginOutput('__GUGU_LOGIN_RESULT__{"userId":"u1","others":[],"deviceId":"-oProxy x"}')).toMatchObject({ deviceId: null })
    expect(parseLoginOutput('__GUGU_LOGIN_ERROR__expired_token\n')).toEqual({ ok: false, error: 'expired_token' })
    expect(parseLoginOutput('garbage')).toEqual({ ok: false, error: null })
  })

  it('manifestUrl 与 install.sh 读的同一个', () => {
    expect(manifestUrl('https://d/r', 'beta', { os: 'Linux', arch: 'aarch64' })).toBe('https://d/r/beta/linux-arm64.txt')
    expect(manifestUrl('https://d/r', 'stable', { os: 'Darwin', arch: 'x86_64' })).toBe('https://d/r/stable/darwin-x64.txt')
  })
})

// ── 五步状态机:假 ssh ────────────────────────────────────────────────────────

type Machine = {
  installed: boolean
  grant: boolean
  /** 装着的版本号(默认 0.2.50);装上新的之后变成 0.2.99。 */
  version?: string
  /** 装着的那份说的协议版本:缺省 = REMOTE_PROTOCOL_VERSION(这台桌面说得上话);null = 不认 `protocol`(太旧);crash = 那条命令崩了。 */
  protocol?: number | null | 'crash'
  running: boolean
  fetcher?: 'curl' | 'wget' | null
  os?: string
  arch?: string
  libc?: string
  freeKb?: number
  accounts?: string[]
  internet?: boolean
  installExit?: number
  installStderr?: string
  serviceOut?: string
  loginOut?: string
  connectFailure?: string
  probeRaw?: string
  user?: string
}

const stdinText = (stdin: Parameters<SpawnSsh>[1]['stdin']) => (typeof stdin === 'string' ? stdin : `<file ${stdin.file}>`)

function fakeSsh(machine: Machine, seen: string[], calls: string[][] = []): SpawnSsh {
  return async (args, { stdin, onStdout, onStderr }): Promise<SshRunResult> => {
    const text = stdinText(stdin)
    seen.push(text)
    calls.push(args)
    if (machine.connectFailure) return { code: 255, stdout: '', stderr: machine.connectFailure }
    onStderr?.('Authenticated to box ([10.0.0.5]:22) using "publickey".\n')
    if (args[args.length - 1].startsWith('cat > ')) {
      if (typeof stdin !== 'string') stdin.onProgress?.(4096)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (text.includes(PROBE_BEGIN)) {
      if (machine.probeRaw !== undefined) return { code: 0, stdout: machine.probeRaw, stderr: '' }
      const lines = [
        PROBE_BEGIN, `os=${machine.os ?? 'Linux'}`, `arch=${machine.arch ?? 'x86_64'}`, `user=${machine.user ?? 'alice'}`, 'hostname=box',
        'distro=Ubuntu 22.04.4 LTS', `libc=${machine.libc ?? 'glibc 2.35'}`,
        ...(machine.installed ? [`installed=${machine.version ?? '0.2.50'}`] : []),
        ...(machine.installed && machine.grant ? ['grant=1'] : []),
        ...(!machine.installed
          ? []
          : machine.protocol === null
            ? ['protocol_exit=2', 'protocol_unknown=1', 'protocol_err=用法:gugu-server <命令>']
            : machine.protocol === 'crash'
              ? ['protocol_exit=139', 'protocol_err=Segmentation fault']
              : ['protocol_exit=0', `protocol=${machine.protocol ?? REMOTE_PROTOCOL_VERSION}`]),
        ...(machine.running ? ['running=1'] : []),
        ...(machine.accounts ?? []).map((a) => `account=${a}`),
        ...(machine.fetcher === null ? [] : [`fetcher=${machine.fetcher ?? 'curl'}`]),
        `freekb=${machine.freeKb ?? 50_000_000}`, 'exec=1',
        PROBE_END,
      ]
      return { code: 0, stdout: lines.join('\n'), stderr: '' }
    }
    if (text.includes('--package')) {
      onStdout?.('正在安装咕咕 server 0.2.99(用传过来的安装包)…\n')
      machine.installed = true
      machine.grant = true
      machine.version = '0.2.99'
      machine.protocol = REMOTE_PROTOCOL_VERSION
      return { code: 0, stdout: '已安装\n', stderr: '' }
    }
    if (text.includes('--no-service --no-login')) {
      if (machine.internet === false) return { code: NO_INTERNET_EXIT, stdout: `${NO_INTERNET_MARK}\n`, stderr: '' }
      onStdout?.('__GUGU_MANIFEST__ 0.2.99 abc https://x\n__GUGU_TOTAL__ 1000\n')
      onStdout?.('正在下载咕咕 server 0.2.99 …\n__GUGU_BYTES__ 500\n')
      if (machine.installExit) return { code: machine.installExit, stdout: '', stderr: machine.installStderr ?? '安装失败:包校验不通过\n' }
      machine.installed = true
      machine.grant = true
      machine.version = '0.2.99'
      machine.protocol = REMOTE_PROTOCOL_VERSION
      return { code: 0, stdout: '已安装\n', stderr: '' }
    }
    if (text.includes('service install')) {
      machine.running = true
      return { code: 0, stdout: machine.serviceOut ?? '已注册为 systemd 用户服务\n', stderr: '' }
    }
    if (text.includes('login --grant-stdin')) {
      return { code: 0, stdout: machine.loginOut ?? '__GUGU_LOGIN_RESULT__{"userId":"u1","email":"me@x.y","others":[]}\n', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: 'unexpected' }
  }
}

function deps(overrides: Partial<SshInstallDeps>): SshInstallDeps {
  return {
    spawnSsh: async () => ({ code: 127, stdout: '', stderr: '' }),
    mintGrant: async () => ({ deviceCode: 'ZGV2aWNlY29kZTEyMzQ1Njc4' }),
    desktopDownload: async () => ({ version: '0.2.99', sha256: 'a'.repeat(64), file: '/tmp/pkg.tgz', size: 4096, installSh: '#!/bin/sh\n' }),
    currentUserId: async () => 'u1',
    controlPath: null,
    downloadBase: 'https://d',
    customDownloadBase: false,
    channel: 'stable',
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function install(machine: Machine, extra: Partial<SshInstallDeps> = {}) {
  const seen: string[] = []
  const calls: string[][] = []
  const states: ServerSshInstallState[] = []
  const run = new InstallRun('r1', 'alice@box', (s) => states.push(s))
  const final = await runSshInstall({ destination: 'alice@box', display: 'alice@box' }, run, deps({ spawnSsh: fakeSsh(machine, seen, calls), ...extra }))
  return { final, seen, calls, states }
}

const statuses = (s: ServerSshInstallState) => Object.fromEntries(s.steps.map((step) => [step.id, step.status]))

describe('runSshInstall', () => {
  it('干净机器:五步依次做完;识别出系统;下载报版本与真实字节', async () => {
    const { final, seen, states } = await install({ installed: false, grant: false, running: false })
    expect(statuses(final)).toEqual({ connect: 'done', detect: 'done', download: 'done', service: 'done', login: 'done' })
    expect(final.machine).toMatchObject({ distro: 'Ubuntu 22.04.4 LTS', arch: 'x86_64', libc: 'glibc 2.35', others: [], alreadySignedIn: false })
    expect(final.result).toEqual({ email: 'me@x.y', others: [], hostname: 'box', userId: 'u1', deviceId: null, alreadySignedIn: false })
    expect(final.failure).toBeNull()
    expect(states.some((s) => s.steps[2].status === 'running' && s.steps[2].version === '0.2.99' && s.steps[2].progress?.done === 500 && s.steps[2].progress.total === 1000)).toBe(true)
    // 认证通过那一刻就切到「识别系统」
    expect(states.some((s) => s.steps[0].status === 'done' && s.steps[1].status === 'running')).toBe(true)
    // 登录凭证只出现在登录那一步的脚本里,也不进日志
    expect(seen.filter((stdin) => stdin.includes('ZGV2aWNlY29kZTEyMzQ1Njc4'))).toHaveLength(1)
    expect(final.log.join('\n')).not.toContain('ZGV2aWNlY29kZTEyMzQ1Njc4')
    expect(final.log).toContain('正在下载咕咕 server 0.2.99 …')
    expect(final.log.some((line) => line.startsWith('__GUGU_BYTES__'))).toBe(false)
  })

  it('#6264 用 root 连上的:识别系统那一步就写明「智能体会以管理员身份运行」,照装;普通用户不提', async () => {
    const root = await install({ installed: false, grant: false, running: false, user: 'root' })
    expect(root.final.warnings).toContainEqual({ kind: 'runsAsRoot' })
    // 下载开始之前就已经写着(人还来得及取消)
    expect(root.states.find((s) => s.steps[2].status === 'running')?.warnings).toContainEqual({ kind: 'runsAsRoot' })
    expect(root.final.failure).toBeNull()
    const alice = await install({ installed: false, grant: false, running: false })
    expect(alice.final.warnings).not.toContainEqual({ kind: 'runsAsRoot' })
  })

  it('已经装好且在跑(有别人登着):不重装、不重启服务,只加一个账号', async () => {
    const { final, seen } = await install({
      installed: true, grant: true, running: true, accounts: ['u9 colleague@lab.edu'],
      loginOut: '__GUGU_LOGIN_RESULT__{"userId":"u1","email":"me@x.y","others":["colleague@lab.edu"]}\n',
    })
    expect(statuses(final)).toEqual({ connect: 'done', detect: 'done', download: 'skipped', service: 'skipped', login: 'done' })
    expect(final.steps[2]).toMatchObject({ skippedBecause: 'alreadyInstalled', version: '0.2.50' })
    expect(final.steps[3].skippedBecause).toBe('alreadyRunning')
    expect(final.machine?.others).toEqual(['colleague@lab.edu'])
    expect(final.result?.others).toEqual(['colleague@lab.edu'])
    expect(seen.some((stdin) => stdin.includes('service install'))).toBe(false)
    expect(seen.some((stdin) => stdin.includes('--no-login'))).toBe(false)
  })

  it('登录那一步把人填的主机名带给 server 当默认名', async () => {
    const { seen } = await install({ installed: false, grant: false, running: false })
    expect(seen.find((stdin) => stdin.includes('login --grant-stdin'))).toContain("--name 'box'")
  })

  it('自己本来就登在那台机器上:如实标出「重新接上」', async () => {
    const { final } = await install({ installed: true, grant: true, running: true, accounts: ['u1 me@x.y'] })
    expect(final.machine?.alreadySignedIn).toBe(true)
    expect(final.result?.alreadySignedIn).toBe(true)
  })

  it('装着的太旧、这台桌面连不上(0.2.131 不认 protocol)且在跑:照常下载安装、当场切过去,再登录', async () => {
    const { final, seen, states } = await install({ installed: true, grant: true, running: true, version: '0.2.131', protocol: null })
    expect(statuses(final)).toEqual({ connect: 'done', detect: 'done', download: 'done', service: 'done', login: 'done' })
    // 下载那一步说的是「从 0.2.131 升级到 0.2.99」,❌「已经装过 · 版本 0.2.131」
    expect(final.steps[2]).toMatchObject({ upgradeFrom: '0.2.131', version: '0.2.99' })
    expect(states.some((s) => s.steps[2].skippedBecause === 'alreadyInstalled')).toBe(false)
    // 当场切:在跑的旧版本由 service install 换下来,❌ 等空闲
    expect(final.steps[3]).toMatchObject({ status: 'done', replaces: '0.2.131' })
    const order = seen.map((stdin) => (stdin.includes('--no-login') ? 'install' : stdin.includes('service install') ? 'service' : stdin.includes('login --grant-stdin') ? 'login' : null)).filter(Boolean)
    expect(order).toEqual(['install', 'service', 'login'])
    expect(final.failure).toBeNull()
  })

  it('装着的说得上话但不是最新:照旧跳过,交给那台机器空闲时自己升(不当场切)', async () => {
    const { final, seen } = await install({ installed: true, grant: true, running: true, version: '0.2.158', protocol: REMOTE_PROTOCOL_VERSION })
    expect(final.steps[2]).toMatchObject({ status: 'skipped', skippedBecause: 'alreadyInstalled', version: '0.2.158' })
    expect(final.steps[2].upgradeFrom).toBeUndefined()
    expect(final.steps[3]).toMatchObject({ status: 'skipped', skippedBecause: 'alreadyRunning' })
    expect(seen.some((stdin) => stdin.includes('service install') || stdin.includes('--no-login'))).toBe(false)
  })

  it('后台升级(upgrade 模式):那台机器上的 server 不认得 match-version ⇒ ❌ 替它整台重装,报「太旧」并带上在那台机器上重装的命令;全程 BatchMode', async () => {
    const { final, seen, calls } = await install({ installed: true, grant: true, running: true, version: '0.2.131', protocol: null }, { mode: 'upgrade' })
    expect(final.failure).toMatchObject({ step: 'detect', reason: 'serverTooOld', detail: 'curl -fsSL https://d/install.sh | sh' })
    expect(seen.some((stdin) => stdin.includes('--no-login') || stdin.includes('--package') || stdin.includes('service install') || stdin.includes('login --grant-stdin'))).toBe(false)
    expect(calls.every((args) => args.includes('BatchMode=yes'))).toBe(true)
  })

  it('问不出装着的版本(protocol 命令崩了):照实报「读不出版本」,❌ 当太旧去重装 —— 装机与后台升级都一样', async () => {
    for (const mode of ['install', 'upgrade'] as const) {
      const { final, seen } = await install({ installed: true, grant: true, running: true, version: '0.2.158', protocol: 'crash' }, { mode })
      expect(final.failure).toMatchObject({ step: 'detect', reason: 'versionCheckFailed', detail: 'exit 139: Segmentation fault' })
      expect(seen.some((stdin) => stdin.includes('service install') || stdin.includes('--no-login') || stdin.includes('--package'))).toBe(false)
    }
  })

  it('装机(非后台升级):装着的够新且在跑 ⇒ 不下载、不重启(切版本只给版本信号发起的后台升级)', async () => {
    const { final, seen } = await install({ installed: true, grant: true, running: true, version: '0.2.158', protocol: REMOTE_PROTOCOL_VERSION })
    expect(final.steps[3]).toMatchObject({ status: 'skipped', skippedBecause: 'alreadyRunning' })
    expect(seen.some((stdin) => stdin.includes('service install') || stdin.includes('--no-login'))).toBe(false)
  })

  it('装过但太旧(不认 --grant-stdin):先升级再登录', async () => {
    const { final, seen } = await install({ installed: true, grant: false, running: false })
    expect(statuses(final)).toMatchObject({ download: 'done', login: 'done' })
    expect(seen.some((stdin) => stdin.includes('--no-login'))).toBe(true)
  })

  it('那台机器上不了网:本机下载 → 经 SSH 传过去 → 用传过去的包装', async () => {
    const downloaded: string[] = []
    const { final, seen, calls, states } = await install({ installed: false, grant: false, running: false, internet: false }, {
      desktopDownload: async ({ manifestUrl: url, onProgress }) => {
        downloaded.push(url)
        onProgress(2048, 4096)
        return { version: '0.2.99', sha256: 'a'.repeat(64), file: '/tmp/pkg.tgz', size: 4096, installSh: '#!/bin/sh\necho install\n' }
      },
    })
    expect(statuses(final)).toMatchObject({ download: 'done', service: 'done', login: 'done' })
    expect(downloaded).toEqual(['https://d/stable/linux-x64.txt'])
    expect(final.steps[2].via).toBe('desktop')
    expect(calls.some((args) => args[args.length - 1] === `cat > ${UPLOAD_FILE}`)).toBe(true)
    expect(seen).toContain('<file /tmp/pkg.tgz>')
    expect(seen.some((stdin) => stdin.includes('--package') && stdin.includes("--version '0.2.99'"))).toBe(true)
    expect(states.some((s) => s.steps[2].progress?.phase === 'download' && s.steps[2].progress.done === 2048)).toBe(true)
    expect(states.some((s) => s.steps[2].progress?.phase === 'upload' && s.steps[2].progress.done === 4096)).toBe(true)
  })

  it('没有 curl / wget:直接走本机下载后传过去', async () => {
    const { final, seen } = await install({ installed: false, grant: false, running: false, fetcher: null })
    expect(final.failure).toBeNull()
    expect(seen.some((stdin) => stdin.includes('--no-service --no-login') && !stdin.includes('--package'))).toBe(false)
    expect(seen.some((stdin) => stdin.includes('--package'))).toBe(true)
  })

  it('本机也下不下来:停在「下载」,说清两头都不通', async () => {
    const { final } = await install({ installed: false, grant: false, running: false, internet: false }, {
      desktopDownload: async () => { throw new Error('getaddrinfo ENOTFOUND') },
    })
    expect(final.failure).toMatchObject({ step: 'download', reason: 'desktopDownloadFailed' })
  })

  it('SSH 认证失败:停在「连接」,说清原因', async () => {
    const { final } = await install({ installed: false, grant: false, running: false, connectFailure: 'alice@box: Permission denied (publickey).' })
    expect(statuses(final)).toEqual({ connect: 'failed', detect: 'pending', download: 'pending', service: 'pending', login: 'pending' })
    expect(final.failure).toMatchObject({ step: 'connect', reason: 'authFailed' })
    expect(final.finished).toBe(true)
  })

  it('指纹变了:失败里带上要删的那条记录', async () => {
    const { final } = await install({ installed: false, grant: false, running: false, connectFailure: 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nSHA256:new+/x.\nHost key verification failed.' })
    expect(final.failure).toMatchObject({ reason: 'hostKeyChanged', hostKey: { host: 'box', fingerprint: 'SHA256:new+/x' } })
  })

  it.each([
    [{ os: 'FreeBSD' }, 'unsupportedOs'],
    [{ libc: 'musl' }, 'unsupportedLibc'],
    [{ libc: 'glibc 2.17' }, 'unsupportedLibc'],
  ] as const)('装不上的系统在「识别系统」当场说:%j → %s', async (patch, reason) => {
    const { final } = await install({ installed: false, grant: false, running: false, ...patch })
    expect(final.failure).toMatchObject({ step: 'detect', reason })
    expect(statuses(final).connect).toBe('done')
  })

  it('空间不够:下载前就停', async () => {
    const { final, seen } = await install({ installed: false, grant: false, running: false, freeKb: 100_000 })
    expect(final.failure).toMatchObject({ step: 'download', reason: 'diskFull' })
    expect(seen.some((stdin) => stdin.includes('--no-login'))).toBe(false)
  })

  it('下载中盘满:认出是盘满', async () => {
    const { final } = await install({ installed: false, grant: false, running: false, installExit: 1, installStderr: 'tar: No space left on device\n安装失败:解包失败\n' })
    expect(final.failure).toMatchObject({ step: 'download', reason: 'diskFull', detail: '安装失败:解包失败' })
  })

  it('install.sh 失败:停在「下载」,带上它自己打的那行', async () => {
    const { final } = await install({ installed: false, grant: false, running: false, installExit: 1 })
    expect(final.failure).toEqual({ step: 'download', reason: 'installFailed', detail: '安装失败:包校验不通过' })
  })

  it('登录脚本把我们的脚本吞了(读不到标记):停在「识别系统」,说是登录脚本的问题', async () => {
    const { final } = await install({ installed: false, grant: false, running: false, probeRaw: 'zsh: welcome\n' })
    expect(final.failure).toMatchObject({ step: 'detect', reason: 'shellStartup' })
  })

  // 被测的就是时间(连接期限、提问期间停表),所以走假钟:期限按宿主自己的节拍数,推进多少由用例定,
  // ❌ 真等 120ms 再拿墙钟量「没超过 2 秒」—— 机器一忙,节拍本身就被拖长。
  it('第一次连接卡住:到点停下并说「没连上」;等人回答提问的时间不算', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      // 卡住的 ssh:被期限掐断(abort)才回;被调起的那一刻期限的节拍已经挂上。
      const hanging = () => {
        let called!: () => void
        const invoked = new Promise<void>((resolve) => { called = resolve })
        const state = { aborted: false }
        const spawnSsh = (authenticate: boolean): SpawnSsh => (_args, { signal, onStderr }) =>
          new Promise((resolve) => {
            if (authenticate) onStderr?.('Authenticated to h ([1.2.3.4]:22) using "password".\n')
            signal.addEventListener('abort', () => {
              state.aborted = true
              resolve({ code: 255, stdout: '', stderr: '' })
            })
            called()
          })
        return { invoked, state, spawnSsh }
      }

      const first = hanging()
      const run = new InstallRun('r4', 'h', () => undefined)
      const pending = runSshInstall({ destination: 'h', display: 'h' }, run, deps({ spawnSsh: first.spawnSsh(false), timeouts: { connect: 120 } }))
      await first.invoked
      await vi.advanceTimersByTimeAsync(120)
      expect(first.state.aborted, '到了 120ms 的期限就掐断(❌ 落回 60s 的默认值)').toBe(true)
      const final = await pending
      expect(final.failure).toMatchObject({ step: 'connect', reason: 'connectTimeout' })

      // 连上了(认证通过)却卡住 = 登录脚本拖住了
      const authed = hanging()
      const run2 = new InstallRun('r5', 'h', () => undefined)
      const pending2 = runSshInstall({ destination: 'h', display: 'h' }, run2, deps({ spawnSsh: authed.spawnSsh(true), timeouts: { connect: 120 } }))
      await authed.invoked
      await vi.advanceTimersByTimeAsync(120)
      expect(authed.state.aborted).toBe(true)
      const final2 = await pending2
      expect(final2.failure).toMatchObject({ step: 'detect', reason: 'shellStartup' })

      // 提问挂着的时候不计时:人翻了 400ms 密码,上限 120ms 也不超时。
      // 问在第一次连接上(受 120ms 连接期限管的只有这一次);之后各步的期限是分钟级,在那里停 400ms 证明不了什么。
      const run3 = new InstallRun('r6', 'h', () => undefined)
      let askedPassword!: () => void
      const asked = new Promise<void>((resolve) => { askedPassword = resolve })
      let prompted = false
      const slowHuman: SpawnSsh = async (args, options) => {
        if (!prompted) {
          prompted = true
          run3.setPrompt({ id: 'p', kind: 'password', message: 'Password:' })
          askedPassword()
          await new Promise((resolve) => setTimeout(resolve, 400))
          run3.setPrompt(null)
        }
        return fakeSsh({ installed: true, grant: true, running: true }, [])(args, options)
      }
      const pending3 = runSshInstall({ destination: 'h', display: 'h' }, run3, deps({ spawnSsh: slowHuman, timeouts: { connect: 120 } }))
      await asked
      await vi.advanceTimersByTimeAsync(400)
      const final3 = await pending3
      expect(final3.failure).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('linger 没开:装好了但把「还差一步」如实摆出来', async () => {
    const { final } = await install({
      installed: false, grant: false, running: false,
      serviceOut: '已注册…\n⚠ 还差一步:…\n  请让管理员执行一次:sudo loginctl enable-linger alice\n',
    })
    expect(final.warnings).toEqual([{ kind: 'lingerMissing', user: 'alice' }])
    expect(final.result).not.toBeNull()
  })

  it('桌面没登录:停在「登录」,❌ 去那台机器上跑登录;如实说那台机器上留下了什么', async () => {
    const { final, seen } = await install({ installed: false, grant: false, running: false }, { mintGrant: async () => ({ error: 'notSignedIn' }) })
    expect(final.failure).toMatchObject({ step: 'login', reason: 'notSignedIn', leftover: 'running' })
    expect(seen.some((stdin) => stdin.includes('login --grant-stdin'))).toBe(false)
  })

  it('那台机器连不上咕咕的云:单独说清要放行外网,❌ 笼统的「登录没完成」', async () => {
    const { final } = await install({ installed: true, grant: true, running: true, loginOut: '[server] TypeError: fetch failed\n' })
    expect(final.failure).toMatchObject({ step: 'login', reason: 'cloudUnreachable' })
  })

  it('那台机器上登录报错:停在「登录」,带上错误码', async () => {
    const { final } = await install({ installed: true, grant: true, running: true, loginOut: '__GUGU_LOGIN_ERROR__expired_token\n' })
    expect(final.failure).toEqual({ step: 'login', reason: 'loginFailed', detail: 'expired_token' })
  })

  it('取消:当前这一步记为 cancelled;装到一半取消时说清留下了什么', async () => {
    const abort = new AbortController()
    const run = new InstallRun('r2', 'h', () => undefined)
    const final = await runSshInstall({ destination: 'h', display: 'h' }, run, deps({
      spawnSsh: async () => {
        abort.abort()
        return { code: null, stdout: '', stderr: '' }
      },
      signal: abort.signal,
    }))
    expect(final.failure).toMatchObject({ step: 'connect', reason: 'cancelled' })
    expect(final.failure?.leftover).toBeUndefined()

    const abort2 = new AbortController()
    const machine: Machine = { installed: false, grant: false, running: false }
    const inner = fakeSsh(machine, [])
    const run2 = new InstallRun('r3', 'h', () => undefined)
    const final2 = await runSshInstall({ destination: 'h', display: 'h' }, run2, deps({
      spawnSsh: async (args, options) => {
        if (typeof options.stdin === 'string' && options.stdin.includes('service install')) {
          abort2.abort()
          return { code: null, stdout: '', stderr: '' }
        }
        return inner(args, options)
      },
      signal: abort2.signal,
    }))
    expect(final2.failure).toMatchObject({ step: 'service', reason: 'cancelled', leftover: 'installed' })
  })

  it('找不到 ssh 程序', async () => {
    const run = new InstallRun('r3', 'h', () => undefined)
    const final = await runSshInstall({ destination: 'h', display: 'h' }, run, deps({
      spawnSsh: async () => {
        throw Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })
      },
    }))
    expect(final.failure).toMatchObject({ step: 'connect', reason: 'sshMissing' })
  })

  it('日志只留最后若干行', () => {
    const run = new InstallRun('r7', 'h', () => undefined)
    run.appendLog(Array.from({ length: 450 }, (_, i) => `line ${i}`).join('\n'))
    expect(run.snapshot().log).toHaveLength(400)
    expect(run.snapshot().log[399]).toBe('line 449')
  })
})

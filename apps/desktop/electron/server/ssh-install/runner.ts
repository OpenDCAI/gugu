/**
 * #6264「从桌面用 SSH 一步装好」的编排:连接 → 识别系统 → 下载 → 注册常驻 → 登录,每一步一次 ssh(复用同一条连接)。
 *
 * 为什么拆成几次 ssh、而不是把 install.sh 整条跑完:每一步有自己的退出码与输出,失败时能说清卡在哪一步、
 * 为什么(behavior「失败时说清楚卡在哪一步、为什么」);进度也是真的 —— 一步做完才亮下一步,下载报真实字节。
 *
 * 不许无声地卡住:第一次连接有硬超时(等人回答提问的时间不算),之后每一步要么有自己的上限、要么「一段时间没有任何输出」就停;
 * 停的时候分得清是没连上、还是连上之后被对方的登录脚本拖住。
 *
 * 那台机器上不了网 / 没有 curl、wget:改由本机下载、经 SSH 传过去再装(照 VS Code / Zed / JetBrains)。
 *
 * 依赖全部注入(spawn ssh、向云端要登录凭证、本机下载),单测里换成假的就能把整条状态机走一遍。
 */
import type {
  ServerSshInstallFailure,
  ServerSshInstallFailureReason,
  ServerSshInstallMachine,
  ServerSshInstallPrompt,
  ServerSshInstallState,
  ServerSshInstallStepId,
} from '../../../src/lib/serverSshInstall'
import { SERVER_SSH_INSTALL_LOG_LINES, SERVER_SSH_INSTALL_STEPS } from '../../../src/lib/serverSshInstall'
import type { DesktopPackage } from './desktop-download'
import {
  archFromUname,
  buildSshArgs,
  changedHostKey,
  classifyInstallFailure,
  classifySshFailure,
  CONNECT_TIMEOUT_MS,
  hostForKnownHosts,
  installFailureDetail,
  installedProtocolUnreadable,
  installedServerTooOld,
  installFromUploadScript,
  incomingManifestScript,
  incomingUploadCommand,
  installScript,
  isAuthenticatedLine,
  isCloudUnreachable,
  isNoInternet,
  lastLines,
  liveLine,
  logLines,
  loginScript,
  oneLineInstallCommand,
  manifestUrl,
  matchApplyScript,
  matchReportScript,
  MIN_FREE_KB,
  parseMatchOutput,
  parseMatchReport,
  parseDownloadProgress,
  machineLimitFromLoginError,
  machineNameFromTarget,
  parseLoginOutput,
  parseProbeOutput,
  platformFromUname,
  probeScript,
  serviceScript,
  serviceWarnings,
  unsupportedPlatform,
  uploadCommand,
  versionedManifestUrl,
  installScriptUrl,
  type ProbeResult,
  type SshTarget,
} from './logic'

export type SshRunResult = { code: number | null; stdout: string; stderr: string }

/**
 * 跑一次 `ssh <args>`,把 `stdin` 整段写进去后关掉标准输入;`stdin` 也可以是一个本机文件(上传安装包),
 * 边写边报写了多少字节。找不到 ssh 程序时以 code === 'ENOENT' 的错误拒绝。
 */
export type SpawnSsh = (
  args: string[],
  options: {
    stdin: string | { file: string; onProgress?: (bytes: number) => void }
    onStdout?: (chunk: string) => void
    onStderr?: (chunk: string) => void
    signal: AbortSignal
  },
) => Promise<SshRunResult>

export type MachineForGrant = { hostname: string; platform: string; arch: string; user: string }
export type MintGrant = (
  machine: MachineForGrant,
) => Promise<{ deviceCode: string } | { error: 'notSignedIn' | 'grantFailed'; detail?: string }>

/** 本机下载(那台机器上不了网时)。`onProgress` 报真实字节。 */
export type DesktopDownload = (options: {
  manifestUrl: string
  /** #6264 要的是指定的那一版:manifestUrl 取不到 / 不是这一版时再看它(通道清单),还不是就算失败。 */
  fallbackManifestUrl?: string
  expectVersion?: string
  installUrl: string
  signal: AbortSignal
  onProgress: (done: number, total: number | null) => void
}) => Promise<DesktopPackage>

export type SshInstallDeps = {
  spawnSsh: SpawnSsh
  mintGrant: MintGrant
  desktopDownload: DesktopDownload
  /** 桌面此刻登着的账号 id(看它是不是已经登在那台机器上);不知道时 null。 */
  currentUserId: () => Promise<string | null>
  /** ControlMaster 套接字路径;null = 不复用连接(Windows)。 */
  controlPath: string | null
  /** 复用连接收尾后留多久;用的是这台机器那条共享连接时一直留着('yes'),装完直接开终端不用再输密码。 */
  controlPersist?: string
  /** 下载站根地址(install.sh、版本清单都在它下面)。 */
  downloadBase: string
  /** 下载根是不是非默认的(开发/测试时由 GUGU_SERVER_DOWNLOAD_BASE 指定):是的话原样带给那台机器上的 install.sh。 */
  customDownloadBase: boolean
  channel: string
  signal: AbortSignal
  /** 超时(毫秒);单测里调小。 */
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>
  /**
   * install = 人在「添加一台机器」里点的(五步走完、登上此刻的账号);
   * upgrade = 设备连接发现那台机器的 server 版本对不上,后台请它把这个账号换成匹配的那一版(装由那台机器的守护进程装,
   * 这里只报版本、传字节、等它换过去;不登录;没人可问,要密码就停 —— BatchMode)。
   */
  mode?: 'install' | 'upgrade'
  /**
   * #6264 upgrade 模式要的:那台机器上是哪个账号、这台桌面是哪一版。只换这一个账号(❌ 整台换、❌ 影响同机别的账号)。
   */
  match?: { accountUserId: string; desktop: { id: string; version: string; protocol: number } }
}

/** `match-version --apply` 的退出码(match-version-cli.ts):守护进程装那一版失败了 / 它连不上下载站、要包的字节。 */
const APPLY_INSTALL_FAILED_EXIT = 6
const APPLY_NEEDS_BYTES_EXIT = 7

export const DEFAULT_TIMEOUTS = {
  /** 第一次连接 + 看一眼系统,总时长(不算等人回答的时间)。 */
  connect: CONNECT_TIMEOUT_MS,
  /** 下载 / 上传 / 安装:这么久没有任何输出就算卡死(进度每秒一行,正常不会这么安静)。 */
  idle: 90_000,
  /** 注册常驻、登录:总时长。 */
  step: 120_000,
}

class StepFailure extends Error {
  constructor(
    readonly reason: ServerSshInstallFailureReason,
    readonly detail?: string,
    readonly extra: Partial<ServerSshInstallFailure> = {},
  ) {
    super(reason)
  }
}

export function initialInstallState(runId: string, target: string): ServerSshInstallState {
  return {
    runId,
    target,
    steps: SERVER_SSH_INSTALL_STEPS.map((id) => ({ id, status: 'pending' as const })),
    machine: null,
    prompt: null,
    warnings: [],
    failure: null,
    result: null,
    finished: false,
    log: [],
  }
}

/** 一次安装的状态与它的变更;快照每变一次就整份推给界面。 */
export class InstallRun {
  private state: ServerSshInstallState

  constructor(
    runId: string,
    target: string,
    private readonly emit: (state: ServerSshInstallState) => void,
  ) {
    this.state = initialInstallState(runId, target)
  }

  snapshot(): ServerSshInstallState {
    return this.state
  }

  update(mutate: (draft: ServerSshInstallState) => void): void {
    const draft: ServerSshInstallState = structuredClone(this.state)
    mutate(draft)
    this.state = draft
    this.emit(draft)
  }

  setStep(id: ServerSshInstallStepId, patch: Partial<ServerSshInstallState['steps'][number]>): void {
    this.update((draft) => {
      const step = draft.steps.find((s) => s.id === id)!
      Object.assign(step, patch)
      if (patch.status && patch.status !== 'running') delete step.live
    })
  }

  setPrompt(prompt: ServerSshInstallPrompt | null): void {
    this.update((draft) => {
      draft.prompt = prompt
    })
  }

  /** 往「查看详情」里追加一段原始输出(去颜色码、去我们自己的机器可读行),只留最后若干行。 */
  appendLog(chunk: string): void {
    const lines = logLines(chunk)
    if (!lines.length) return
    this.update((draft) => {
      draft.log.push(...lines)
      if (draft.log.length > SERVER_SSH_INSTALL_LOG_LINES) draft.log.splice(0, draft.log.length - SERVER_SSH_INSTALL_LOG_LINES)
    })
  }
}

function describeMachine(probe: ProbeResult, currentUserId: string | null): ServerSshInstallMachine {
  const signedIn = probe.accounts
  return {
    os: probe.os,
    arch: probe.arch,
    distro: probe.distro,
    libc: probe.libc,
    hostname: probe.hostname,
    user: probe.user,
    installedVersion: probe.installedVersion,
    others: signedIn.filter((account) => account.userId !== currentUserId).map((account) => account.email ?? account.userId),
    alreadySignedIn: currentUserId !== null && signedIn.some((account) => account.userId === currentUserId),
  }
}

export async function runSshInstall(target: SshTarget, run: InstallRun, deps: SshInstallDeps): Promise<ServerSshInstallState> {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts }
  const upgradeOnly = deps.mode === 'upgrade'
  const scriptArgs = buildSshArgs(target, { controlPath: deps.controlPath, persist: deps.controlPersist, batch: upgradeOnly })
  let current: ServerSshInstallStepId = 'connect'
  // 这次运行在那台机器上留下了什么:取消 / 失败时如实说(behavior「不留半截东西而不说」)。
  let didInstall = false
  let didService = false
  let authenticated = false

  /**
   * 跑一次 ssh。`limit` 两种:total = 这一次总共最多多久;idle = 这么久没有任何输出/进度就算卡死。
   * 两种都不算等人回答提问的时间 —— 人在看指纹、翻密码时,不能被当成机器卡住。
   */
  const ssh = async (
    stdin: Parameters<SpawnSsh>[1]['stdin'],
    options: {
      args?: string[]
      limit: { kind: 'total' | 'idle'; ms: number }
      timeoutReason: ServerSshInstallFailureReason
      onStdout?: (chunk: string) => void
    },
  ): Promise<SshRunResult> => {
    if (deps.signal.aborted) throw new StepFailure('cancelled')
    const call = new AbortController()
    const onAbort = () => call.abort()
    deps.signal.addEventListener('abort', onAbort, { once: true })
    let quiet = 0
    let timedOut = false
    const tick = Math.max(10, Math.min(250, Math.floor(options.limit.ms / 4)))
    const timer = setInterval(() => {
      if (run.snapshot().prompt) return
      quiet += tick
      if (quiet >= options.limit.ms) {
        timedOut = true
        call.abort()
      }
    }, tick)
    const activity = () => {
      if (options.limit.kind === 'idle') quiet = 0
    }
    const withProgress = typeof stdin === 'string'
      ? stdin
      : { file: stdin.file, onProgress: (bytes: number) => { activity(); stdin.onProgress?.(bytes) } }
    let result: SshRunResult
    try {
      result = await deps.spawnSsh(options.args ?? scriptArgs, {
        stdin: withProgress,
        signal: call.signal,
        onStdout: (chunk) => {
          activity()
          run.appendLog(chunk)
          options.onStdout?.(chunk)
        },
        onStderr: (chunk) => {
          activity()
          run.appendLog(chunk)
          if (!authenticated && isAuthenticatedLine(chunk)) {
            authenticated = true
            markConnected()
          }
        },
      })
    } catch (error) {
      if (deps.signal.aborted) throw new StepFailure('cancelled')
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new StepFailure('sshMissing')
      throw new StepFailure('unknown', error instanceof Error ? error.message : String(error))
    } finally {
      clearInterval(timer)
      deps.signal.removeEventListener('abort', onAbort)
    }
    if (deps.signal.aborted) throw new StepFailure('cancelled')
    if (!authenticated && isAuthenticatedLine(result.stderr)) {
      authenticated = true
      markConnected()
    }
    if (timedOut) {
      // 连接阶段已经认证通过却迟迟拿不到结果 = 被对方的登录脚本(.bashrc 里的 exec / 交互提问)拖住了。
      const reason = options.timeoutReason === 'connectTimeout' && authenticated ? 'shellStartup' : options.timeoutReason
      throw new StepFailure(reason, lastLines(`${result.stdout}\n${result.stderr}`))
    }
    // 255 是 ssh 自己的错(连不上、认证失败、中途断线),与远端脚本的退出码分开处理。
    if (result.code === 255) {
      const reason = classifySshFailure(result.stderr)
      throw new StepFailure(
        reason,
        lastLines(result.stderr),
        reason === 'hostKeyChanged' ? { hostKey: changedHostKey(result.stderr, hostForKnownHosts(target)) } : {},
      )
    }
    return result
  }

  /** 认证通过:「连接」亮成完成,「识别系统」开始。 */
  function markConnected() {
    const connect = run.snapshot().steps.find((s) => s.id === 'connect')
    if (connect?.status !== 'running') return
    run.setStep('connect', { status: 'done' })
    run.setStep('detect', { status: 'running' })
    current = 'detect'
  }

  const probe = async (limit: { kind: 'total' | 'idle'; ms: number }, timeoutReason: ServerSshInstallFailureReason): Promise<ProbeResult> => {
    const result = await ssh(probeScript(), { limit, timeoutReason })
    const parsed = parseProbeOutput(result.stdout)
    // 认证通过、脚本也跑了,却读不到标记:对方的登录脚本把我们的脚本吞了或改了(`exec zsh`、往 stdin 读东西)。
    if (!parsed) throw new StepFailure('shellStartup', lastLines(`${result.stdout}\n${result.stderr}`))
    return parsed
  }

  const leftover = () => (didService ? 'running' : didInstall ? 'installed' : null)

  // 字节进度最多每 200ms 推一次:上传按 64KB 一块回调,一个包就是上千次,每次都整份快照过 IPC 是白白压界面。
  let lastProgressAt = 0
  const setProgress = (progress: NonNullable<ServerSshInstallState['steps'][number]['progress']>) => {
    const now = Date.now()
    const final = progress.total !== null && progress.done >= progress.total
    if (!final && now - lastProgressAt < 200) return
    lastProgressAt = now
    run.setStep('download', { progress })
  }


  /**
   * 那台机器连不上下载站(它自己下载时记下的):本机下好这一版、经 SSH 放进它的 `versions/.incoming/`(先包、后清单行),由它的守护进程去装。
   * 桌面 ❌ 在那边装:换版装东西的只有守护进程一个。
   */
  const uploadIncoming = async (version: string, pinnedManifest: string, channelManifest: string): Promise<void> => {
    run.appendLog(`── 那台机器连不上下载站,改由本机下载 ${version} 后传过去 ──`)
    run.setStep('download', { progress: { phase: 'download', done: 0, total: null } })
    let pkg: DesktopPackage
    try {
      pkg = await deps.desktopDownload({
        manifestUrl: pinnedManifest,
        fallbackManifestUrl: channelManifest,
        expectVersion: version,
        installUrl: installScriptUrl(deps.downloadBase, deps.channel),
        signal: deps.signal,
        onProgress: (done, total) => setProgress({ phase: 'download', done, total }),
      })
    } catch (error) {
      if (deps.signal.aborted) throw new StepFailure('cancelled')
      throw new StepFailure('desktopDownloadFailed', error instanceof Error ? error.message : String(error))
    }
    run.setStep('download', { progress: { phase: 'upload', done: 0, total: pkg.size } })
    const uploaded = await ssh(
      { file: pkg.file, onProgress: (bytes) => setProgress({ phase: 'upload', done: bytes, total: pkg.size }) },
      { args: buildSshArgs(target, { controlPath: deps.controlPath, persist: deps.controlPersist, batch: true, remoteCommand: incomingUploadCommand(version) }), limit: { kind: 'idle', ms: timeouts.idle }, timeoutReason: 'timeout' },
    )
    if (uploaded.code !== 0) throw new StepFailure('uploadFailed', lastLines(`${uploaded.stdout}\n${uploaded.stderr}`))
    const marked = await ssh(incomingManifestScript(version, pkg.sha256), { limit: { kind: 'total', ms: timeouts.step }, timeoutReason: 'timeout' })
    if (marked.code !== 0) throw new StepFailure('uploadFailed', lastLines(`${marked.stdout}\n${marked.stderr}`))
  }

  try {
    // ① 连接 + ② 识别系统:同一次 ssh,认证通过那一刻切到「识别系统」。
    run.appendLog(`── 连接 ${target.display} ──`)
    run.setStep('connect', { status: 'running' })
    let found = await probe({ kind: 'total', ms: timeouts.connect }, 'connectTimeout')
    markConnected() // ssh 没打「Authenticated to」(老版本 / Windows)时,拿到结果就算连上了。
    current = 'detect'
    const userId = await deps.currentUserId().catch(() => null)
    run.update((draft) => {
      draft.machine = describeMachine(found, userId)
    })
    const unsupported = unsupportedPlatform(found)
    if (unsupported) {
      throw new StepFailure(unsupported, [found.distro || found.os, found.arch, found.libc].filter(Boolean).join(' · '))
    }
    // 装着一份、却问不出它说哪一版协议(那条命令崩溃 / 超时 / 没权限):照实报,❌ 当太旧去重装。
    if (installedProtocolUnreadable(found)) throw new StepFailure('versionCheckFailed', found.protocolError ?? undefined)
    run.setStep('detect', { status: 'done' })
    // root 装的 = 智能体以管理员身份跑、能改整台机器。照装(用户可能就是要这样),但当场写明,❌ 只在 install.sh 里打一句。
    if (found.user === 'root') run.update((draft) => void draft.warnings.push({ kind: 'runsAsRoot' }))

    // #6264 后台升级 = 这个账号换成和这台桌面匹配的那一版,只动这一个账号。装那一版的只有那台机器上的守护进程
    // (server-account-converge.ts):这里只报版本、请它换、等它换过去;它说连不上下载站,就把包的字节传进它的 incoming 再请一次。
    if (upgradeOnly) {
      // 不认得 match-version 的 server(#6504 之前的开发构建,发布过的版本都认得):❌ 替它整台重装,请人在那台机器上重装。
      if (!found.supportsMatch) {
        throw new StepFailure('serverTooOld', oneLineInstallCommand(deps.downloadBase, deps.channel, found.fetcher === 'wget' ? 'wget' : 'curl'))
      }
      if (!deps.match) throw new StepFailure('unknown', 'this desktop could not tell which version it is')
      current = 'download'
      const reported = await ssh(matchReportScript({ accountUserId: deps.match.accountUserId, desktopId: deps.match.desktop.id, ...deps.match.desktop }), {
        limit: { kind: 'total', ms: timeouts.step },
        timeoutReason: 'timeout',
      })
      const report = reported.code === 0 ? parseMatchReport(reported.stdout) : null
      if (!report) throw new StepFailure('installFailed', lastLines(`${reported.stdout}\n${reported.stderr}`))
      run.update((draft) => void (draft.match = { target: report.target, running: report.running }))
      if (report.target === report.running) {
        // 已经是目标版本(这台桌面比同账号另一台旧,或者本来就对得上):什么也不换。
        run.setStep('download', { status: 'skipped', skippedBecause: 'alreadyInstalled', version: report.target })
        run.setStep('service', { status: 'skipped', skippedBecause: 'alreadyRunning' })
        run.setStep('login', { status: 'skipped', skippedBecause: 'alreadySignedIn' })
        run.update((draft) => void (draft.finished = true))
        return run.snapshot()
      }
      if (report.installed) {
        run.setStep('download', { status: 'skipped', skippedBecause: 'alreadyInstalled', version: report.target })
      } else {
        if (found.freeKb !== null && found.freeKb < MIN_FREE_KB) throw new StepFailure('diskFull', `${Math.round(found.freeKb / 1024)} MB`)
        run.setStep('download', { status: 'running', via: 'remote', version: report.target, ...(report.running ? { upgradeFrom: report.running } : {}) })
      }
      run.appendLog(`── 这个账号换到 ${report.target} ──`)
      const match = deps.match
      const apply = () => ssh(matchApplyScript({ accountUserId: match.accountUserId, version: report.target }), {
        // 没装的那一版由守护进程先下载、试跑(match-version 自己最多等 10 分钟)。
        limit: { kind: 'total', ms: 11 * 60_000 },
        timeoutReason: 'timeout',
      })
      let applied = await apply()
      if (applied.code === APPLY_NEEDS_BYTES_EXIT) {
        run.setStep('download', { via: 'desktop' })
        await uploadIncoming(report.target, versionedManifestUrl(deps.downloadBase, report.target, found), manifestUrl(deps.downloadBase, deps.channel, found))
        applied = await apply()
      }
      if (applied.code !== 0 || parseMatchOutput(applied.stdout)?.switched !== report.target) {
        throw new StepFailure(applied.code === APPLY_INSTALL_FAILED_EXIT ? 'installFailed' : 'serviceFailed', lastLines(`${applied.stdout}\n${applied.stderr}`))
      }
      if (!report.installed) run.setStep('download', { status: 'done', version: report.target })
      run.setStep('service', { status: 'done', ...(report.running ? { replaces: report.running } : {}) })
      run.setStep('login', { status: 'skipped', skippedBecause: 'alreadySignedIn' })
      run.update((draft) => void (draft.finished = true))
      return run.snapshot()
    }

    // ③ 下载:已经装过、这台桌面跟它说得上话 ⇒ 不重装。重装会立刻改 current 指针,绕过「空闲时才切版本」(behavior 第 5 条),
    //    版本交给那台机器自己的后台升级。
    //    太旧到这台桌面连不上(判据与设备行「版本太旧」同一个)⇒ 照常下载安装、下一步当场切过去(照 VS Code Remote-SSH:
    //    客户端发现 server 对不上就装一份对得上的):旧到连不上的 server 上不可能有能用的会话,「等空闲」没有要保护的东西。
    current = 'download'
    const tooOld = installedServerTooOld(found)
    const replacing = tooOld && found.running ? found.installedVersion : null
    if (found.installedVersion && found.supportsGrant && !tooOld) {
      run.setStep('download', {
        status: 'skipped',
        skippedBecause: 'alreadyInstalled',
        ...(found.installedVersion !== 'unknown' ? { version: found.installedVersion } : {}),
      })
    } else {
      if (found.freeKb !== null && found.freeKb < MIN_FREE_KB) {
        throw new StepFailure('diskFull', `${Math.round(found.freeKb / 1024)} MB`)
      }
      run.setStep('download', {
        status: 'running',
        via: 'remote',
        ...(tooOld && found.installedVersion ? { upgradeFrom: found.installedVersion } : {}),
      })
      const installUrl = installScriptUrl(deps.downloadBase, deps.channel)
      const manifest = manifestUrl(deps.downloadBase, deps.channel, found)
      let viaDesktop = !found.fetcher
      if (!viaDesktop) {
        run.appendLog(`── 在 ${target.display} 上下载 ──`)
        let total: number | null = null
        const installed = await ssh(
          installScript({ installUrl, manifestUrl: manifest, channel: deps.channel, downloadBase: deps.customDownloadBase ? deps.downloadBase : null }),
          {
            limit: { kind: 'idle', ms: timeouts.idle },
            timeoutReason: 'timeout',
            onStdout: (chunk) => {
              const progress = parseDownloadProgress(chunk)
              if (progress.total !== undefined) total = progress.total
              const line = liveLine(chunk)
              run.setStep('download', {
                ...(progress.version ? { version: progress.version } : {}),
                ...(progress.done !== undefined ? { progress: { phase: 'download', done: progress.done, total } } : {}),
                ...(line ? { live: line } : {}),
              })
            },
          },
        )
        if (installed.code !== 0) {
          if (!isNoInternet(installed)) {
            const detail = installFailureDetail(installed.stderr, installed.stdout)
            throw new StepFailure(classifyInstallFailure(`${installed.stdout}\n${installed.stderr}`), detail)
          }
          viaDesktop = true
        }
      }
      if (viaDesktop) {
        // 那台机器上不了网(或没有 curl / wget):本机下好、经 SSH 传过去。
        run.appendLog(`── 那台机器连不上下载站,改由本机下载后传过去 ──`)
        run.setStep('download', { via: 'desktop', progress: { phase: 'download', done: 0, total: null } })
        let pkg: DesktopPackage
        try {
          pkg = await deps.desktopDownload({
            manifestUrl: manifest,
            installUrl,
            signal: deps.signal,
            onProgress: (done, total) => setProgress({ phase: 'download', done, total }),
          })
        } catch (error) {
          if (deps.signal.aborted) throw new StepFailure('cancelled')
          throw new StepFailure('desktopDownloadFailed', error instanceof Error ? error.message : String(error))
        }
        run.setStep('download', { version: pkg.version, progress: { phase: 'upload', done: 0, total: pkg.size } })
        const uploaded = await ssh(
          {
            file: pkg.file,
            onProgress: (bytes) => setProgress({ phase: 'upload', done: bytes, total: pkg.size }),
          },
          { args: buildSshArgs(target, { controlPath: deps.controlPath, persist: deps.controlPersist, remoteCommand: uploadCommand() }), limit: { kind: 'idle', ms: timeouts.idle }, timeoutReason: 'timeout' },
        )
        if (uploaded.code !== 0) {
          const text = `${uploaded.stdout}\n${uploaded.stderr}`
          const reason = classifyInstallFailure(text)
          throw new StepFailure(reason === 'installFailed' ? 'uploadFailed' : reason, lastLines(text))
        }
        const installed = await ssh(
          installFromUploadScript({ installSh: pkg.installSh, channel: deps.channel, version: pkg.version, sha256: pkg.sha256 }),
          {
            limit: { kind: 'idle', ms: timeouts.idle },
            timeoutReason: 'timeout',
            onStdout: (chunk) => {
              const line = liveLine(chunk)
              if (line) run.setStep('download', { live: line })
            },
          },
        )
        if (installed.code !== 0) {
          const detail = installFailureDetail(installed.stderr, installed.stdout)
          throw new StepFailure(classifyInstallFailure(`${installed.stdout}\n${installed.stderr}`), detail)
        }
      }
      didInstall = true
      found = await probe({ kind: 'total', ms: timeouts.step }, 'timeout')
      run.setStep('download', { status: 'done', ...(found.installedVersion && found.installedVersion !== 'unknown' ? { version: found.installedVersion } : {}) })
    }

    // ④ 注册常驻:已经在跑就不动它 —— 重新注册会重启 server,顶掉这台机器上别人正在跑的 agent(behavior 第 7 条)。
    //    例外:在跑的那个太旧、刚装了新的 ⇒ 当场换下来(service install 负责「此刻真在跑的就是这一版」)。
    //    例外二:后台升级(只由版本信号发起)而装着的已经够新 = 在跑的还是旧进程(装好了新版、还在等空闲才切):
    //    ❌ 再下载,当场让它切到装着的这一版(同一条 service install;在跑的正是这一版时它什么也不换)。
    current = 'service'
    if (found.running && !replacing) {
      run.setStep('service', { status: 'skipped', skippedBecause: 'alreadyRunning' })
    } else {
      run.setStep('service', { status: 'running', ...(replacing ? { replaces: replacing } : {}) })
      run.appendLog('── 注册常驻服务 ──')
      const service = await ssh(serviceScript(), { limit: { kind: 'total', ms: timeouts.step }, timeoutReason: 'timeout' })
      if (service.code !== 0) throw new StepFailure('serviceFailed', lastLines(`${service.stdout}\n${service.stderr}`))
      didService = true
      const warnings = serviceWarnings(service.stdout)
      if (warnings.length) run.update((draft) => void draft.warnings.push(...warnings))
      run.setStep('service', { status: 'done' })
    }

    // ⑤ 登录:登上桌面此刻登着的那个人。凭证以桌面自己的身份向云端要,经标准输入递过去。
    current = 'login'
    run.setStep('login', { status: 'running' })
    run.appendLog('── 登录 ──')
    if (!found.supportsGrant) throw new StepFailure('serverTooOld', found.installedVersion ?? undefined)
    const grant = await deps.mintGrant({
      hostname: found.hostname,
      platform: platformFromUname(found.os),
      arch: archFromUname(found.arch),
      user: found.user,
    })
    if ('error' in grant) throw new StepFailure(grant.error, grant.detail)
    const login = await ssh(loginScript(grant.deviceCode, machineNameFromTarget(target)), { limit: { kind: 'total', ms: timeouts.step }, timeoutReason: 'timeout' })
    const outcome = parseLoginOutput(login.stdout)
    if (!outcome.ok) {
      // #6264 这个账号的咕咕 server 数到上限了:说清哪条上限、用了几台,界面就地给「升级会员 / 移除一台机器」。
      const limited = machineLimitFromLoginError(outcome.error)
      if (limited) throw new StepFailure('machineLimit', undefined, limited.refusal ? { machineLimit: limited.refusal } : {})
      const detail = outcome.error ?? lastLines(`${login.stdout}\n${login.stderr}`)
      throw new StepFailure(isCloudUnreachable(`${detail}\n${login.stdout}\n${login.stderr}`) ? 'cloudUnreachable' : 'loginFailed', detail)
    }
    run.setStep('login', { status: 'done' })
    const machine = run.snapshot().machine
    run.update((draft) => {
      draft.result = {
        email: outcome.email,
        others: outcome.others,
        hostname: found.hostname,
        userId: outcome.userId,
        deviceId: outcome.deviceId,
        alreadySignedIn: machine?.alreadySignedIn ?? false,
      }
      draft.finished = true
    })
  } catch (error) {
    const failure = error instanceof StepFailure ? error : new StepFailure('unknown', error instanceof Error ? error.message : String(error))
    const step = current
    run.setStep(step, { status: 'failed' })
    if (failure.detail) run.appendLog(failure.detail)
    const left = leftover()
    run.update((draft) => {
      draft.prompt = null
      draft.failure = {
        step,
        reason: failure.reason,
        ...(failure.detail ? { detail: failure.detail } : {}),
        ...failure.extra,
        ...(left ? { leftover: left } : {}),
      }
      draft.finished = true
    })
  }
  return run.snapshot()
}

/** 定义在 logic.ts(直连终端也用),这里保留旧的出口。 */
export { hostForKnownHosts } from './logic'

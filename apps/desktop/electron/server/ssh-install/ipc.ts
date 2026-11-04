/**
 * #6264「从桌面用 SSH 一步装好」:主进程这一侧的接线(设置 → 设备 → 添加一台机器)。
 *
 * 真正的 ssh 用本机系统自带的 `ssh` 程序(见 logic.ts 开头);密码 / 口令 / 新主机指纹经 askpass 回到界面问人。
 * 登录凭证以桌面此刻登着的身份向云端 server-login/grant 要(见 nmhjklnm/gugu-supabase 的 supabase/functions/server-login),
 * 只在内存里过一手就经 SSH 标准输入递走,❌ 写日志、❌ 发给渲染层。
 */
import { spawn } from '@gugu/core/local/childProcess'
import crypto from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import type { RuntimeAuth } from '@gugu/core'
import {
  SERVER_SSH_INSTALL_CHANNELS,
  type ServerSshInstallAnswer,
  type ServerSshInstallInfo,
  type ServerSshInstallStartRequest,
  type ServerSshInstallStartResponse,
  type ServerSshInstallState,
} from '../../../src/lib/serverSshInstall'
import { createLogger } from '../../lib/logger'
import { serverDownloadBase } from '../server-download'
import { createSshPromptBroker, openAskpassWorkspace, workspaceControlPath, type AskpassWorkspace, type SshPromptBroker } from '../ssh-prompts'
import { downloadServerOnDesktop } from './desktop-download'
import { oneLineInstallCommand, parseSshCommand, SHARED_CONTROL_PERSIST, type SshTarget } from './logic'
import { InstallRun, runSshInstall } from './runner'
import { readSshConfigHosts } from './ssh-config-hosts'
import { cloudMintGrant, systemSpawnSsh } from './system'
import { installGuguKeyWithPassword, withGuguIdentity } from '../ssh-key-install'
import type { SshMachine } from '../ssh-machines'

const log = createLogger('server-ssh-install')

type ActiveRun = {
  run: InstallRun
  abort: AbortController
  prompts: SshPromptBroker
}

export function registerServerSshInstallIpc(options: {
  getWindow: () => BrowserWindow | null
  getAuth: () => Promise<RuntimeAuth | null>
  /** 桌面自己的更新通道:Beta 桌面装 Beta 的 server,其余装正式版。 */
  channel: 'stable' | 'beta'
  /**
   * 装好并登上之后记一笔「这台设备是用 SSH 装上的、怎么连过去」(见 ../ssh-machines.ts):
   * 它上面的「编程」会话从此能经 SSH 直连出终端。
   */
  rememberMachine: (machine: SshMachine) => void
  /** #6264「重新登录」:这台桌面记着的那台机器怎么 SSH 过去(没有 = null)。 */
  machineTarget?: (deviceId: string) => SshTarget | null
  /**
   * #6264「下次免密」:咕咕自己那把 SSH 钥匙放在哪(给了,密码提问上才出「以后不用再输密码」)。
   * 装好之后替人把它装到那台机器上,验证过了才关联到这台机器(见 ../ssh-key-install.ts)。
   */
  keyDir?: string
  /** 单测替身;默认真装。 */
  installKey?: typeof installGuguKeyWithPassword
  /**
   * #6264 这台机器那条共享连接的套接字(终端、文件、端口转发都骑在它上面,见 ssh-machines.ts terminalControlPath)。
   * 给了:装机就用它、装完 ❌ 收掉 —— 刚输过密码,接着开终端不用再输一遍(照 VS Code:一台机器只认证一次)。
   * 没给 / 拿不到(Windows):装机用自己的临时连接,装完收掉(老样子)。
   */
  sharedControlPath?: () => string | null
}): void {
  const runs = new Map<string, ActiveRun>()

  const push = (state: ServerSshInstallState) => {
    const win = options.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(SERVER_SSH_INSTALL_CHANNELS.state, state)
  }

  ipcMain.handle(SERVER_SSH_INSTALL_CHANNELS.info, (): ServerSshInstallInfo => ({
    installCommand: oneLineInstallCommand(serverDownloadBase(), options.channel),
    installCommandWget: oneLineInstallCommand(serverDownloadBase(), options.channel, 'wget'),
  }))

  ipcMain.handle(SERVER_SSH_INSTALL_CHANNELS.listHosts, () => readSshConfigHosts())

  ipcMain.handle(SERVER_SSH_INSTALL_CHANNELS.start, async (_event, request: ServerSshInstallStartRequest): Promise<ServerSshInstallStartResponse> => {
    const remembered =
      request && 'deviceId' in request && typeof request.deviceId === 'string' ? (options.machineTarget?.(request.deviceId) ?? null) : null
    const parsed = remembered ?? parseSshCommand(String(request && 'target' in request ? request.target : ''))
    if ('problem' in parsed) {
      return { error: 'invalidTarget', problem: parsed.problem, ...(parsed.option ? { option: parsed.option } : {}) }
    }
    const target = parsed
    const runId = crypto.randomUUID()
    const abort = new AbortController()
    const run = new InstallRun(runId, target.display, push)
    // 提问的分类、「再试一次」、ssh 不等了就收起:与卸载、直连终端同一个 broker(../ssh-prompts.ts)。
    const prompts = createSshPromptBroker({
      onPrompt: (prompt) => run.setPrompt(prompt),
      stopped: () => abort.signal.aborted,
      offerKeyInstall: Boolean(options.keyDir),
    })
    const active: ActiveRun = { run, abort, prompts }
    runs.set(runId, active)

    void (async () => {
      let workspace: AskpassWorkspace | null = null
      let env: NodeJS.ProcessEnv = process.env
      let controlPath: string | null = null
      let keepConnection = false
      try {
        // askpass 与 ControlMaster 套接字放在同一个只有本用户进得去的短目录里。
        workspace = await openAskpassWorkspace(prompts.handler)
        const workDir = workspace.dir
        env = { ...process.env, ...workspace.env }
        const base = serverDownloadBase()
        const packageDir = workDir
        const shared = options.sharedControlPath?.() ?? null
        controlPath = shared ?? workspaceControlPath(workDir)
        keepConnection = shared !== null
        const final = await runSshInstall(target, run, {
          spawnSsh: systemSpawnSsh(env),
          mintGrant: cloudMintGrant(options.getAuth),
          desktopDownload: (request) => downloadServerOnDesktop({ ...request, dir: packageDir }),
          currentUserId: async () => (await options.getAuth())?.userId ?? null,
          controlPath,
          ...(keepConnection ? { controlPersist: SHARED_CONTROL_PERSIST } : {}),
          downloadBase: base,
          // 只有指到别处时才带给那台机器上的 install.sh;默认地址它自己知道。
          customDownloadBase: Boolean(process.env.GUGU_SERVER_DOWNLOAD_BASE?.trim()),
          channel: options.channel,
          signal: abort.signal,
        })
        const result = final.result
        // 结果进主进程日志(反馈时随日志附带);界面上的原始输出另在「查看详情」里。
        if (final.failure) {
          log.warn({ target: target.display, step: final.failure.step, reason: final.failure.reason, detail: final.failure.detail ?? null }, 'SSH 装机没完成')
        } else {
          log.info({ target: target.display, alreadySignedIn: result?.alreadySignedIn ?? false, via: final.steps.find((s) => s.id === 'download')?.via ?? null }, 'SSH 装机完成')
        }
        const remember = (machineOptions: string[] | undefined) => {
          if (!result?.deviceId) return
          try {
            options.rememberMachine({
              deviceId: result.deviceId,
              ownerUserId: result.userId,
              destination: target.destination,
              ...(target.port !== undefined ? { port: target.port } : {}),
              ...(machineOptions?.length ? { options: machineOptions } : {}),
              display: target.display,
              addedAt: new Date().toISOString(),
            })
          } catch (error) {
            // 记不下来只影响「编程」直连(那台机器照样能用「通用」),装机本身已经成功 —— 如实记一笔,不改结果。
            log.warn({ err: error instanceof Error ? error.message : String(error) }, '记不下这台机器的 SSH 直连映射')
          }
        }
        remember(target.options)
        // 「下次免密」:整件事做成了、答密码时勾了,才去装钥匙(复用还开着的那条连接;装不上不改装机结果)。
        // 装好并验证过,才把钥匙关联到这台机器(再记一次,只多一个 IdentityFile)。
        const keyRequest = prompts.takeKeyRequest()
        if (result?.deviceId && keyRequest && options.keyDir) {
          run.update((draft) => {
            draft.keyInstall = { status: 'working' }
          })
          const outcome = await (options.installKey ?? installGuguKeyWithPassword)({
            target,
            controlPath,
            password: keyRequest.password,
            keyDir: options.keyDir,
            log: (message, detail) => log.info(detail ?? {}, message),
          }).catch((error: unknown) => {
            log.warn({ err: error instanceof Error ? error.message : String(error) }, '「下次免密」没做成')
            return { status: 'failed' as const, reason: 'unreachable' as const }
          })
          if (outcome.status === 'installed' && outcome.keyPath) remember(withGuguIdentity(target.options, outcome.keyPath))
          run.update((draft) => {
            draft.keyInstall = outcome.status === 'installed' ? { status: 'installed' } : { status: 'failed', reason: outcome.reason }
          })
        }
      } catch (error) {
        // 走到这里的只有本机这头的准备工作出错(建目录、开 askpass);四步本身的失败 runSshInstall 自己记。
        if (!run.snapshot().finished) {
          const detail = error instanceof Error ? error.message : String(error)
          run.appendLog(detail)
          run.update((draft) => {
            draft.steps[0].status = 'failed'
            draft.failure = { step: 'connect', reason: 'unknown', detail }
            draft.finished = true
          })
        }
      } finally {
        prompts.cancelAll()
        // 用的是共享连接:留着给终端、文件、端口转发(咕咕退出 / 机器移除时才收)。
        if (controlPath && !keepConnection) {
          // 收掉复用的那条连接,❌ 留一个后台 ssh 进程挂两分钟。
          await new Promise<void>((resolve) => {
            // 选项照装的时候一样带上:ControlPath 里的 %C 按主机、端口、用户、跳板算,少一个就对不上那条连接。
            const args = ['-o', `ControlPath=${controlPath}`, '-O', 'exit']
            if (target.port !== undefined) args.push('-p', String(target.port))
            if (target.options?.length) args.push(...target.options)
            const closer = spawn('ssh', [...args, '--', target.destination], { env, stdio: 'ignore' })
            closer.on('error', () => resolve())
            closer.on('close', () => resolve())
          })
        }
        await workspace?.close()
        runs.delete(runId)
      }
    })()

    return { runId, state: run.snapshot() }
  })

  ipcMain.handle(SERVER_SSH_INSTALL_CHANNELS.cancel, (_event, runId: string) => {
    const active = runs.get(String(runId))
    if (!active) return false
    active.abort.abort()
    active.prompts.cancelAll()
    return true
  })

  ipcMain.handle(SERVER_SSH_INSTALL_CHANNELS.answer, (_event, answer: ServerSshInstallAnswer) => {
    const active = runs.get(String(answer?.runId))
    if (!active) return false
    return active.prompts.answer(String(answer?.promptId), typeof answer.value === 'string' ? answer.value : null, {
      installKey: answer?.installKey === true,
    })
  })
}

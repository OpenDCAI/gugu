/**
 * #6264「从这台机器上卸载咕咕 server」的主进程接线(纯逻辑与状态机在 ssh-uninstall.ts)。
 *
 * 连法与「添加一台机器」完全相同:本机的 ssh 程序、本机 ~/.ssh/config;要密码 / 口令 / 确认新指纹时
 * 经 askpass 回到界面问人(同一个 askpass 模块)。目的地来自这台桌面记下的映射(ssh-machines.ts),
 * 渲染层只给设备 id,❌ 不能让界面指定任意地址去执行删除脚本。
 */
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import type { BrowserWindow, IpcMain } from 'electron'
import {
  SERVER_SSH_MACHINES_CHANNELS,
  type ServerUninstallAnswer,
  type ServerUninstallStartResponse,
  type ServerUninstallState,
} from '../../src/lib/serverSshMachines'
import { createSshPromptBroker, openAskpassWorkspace, workspaceControlPath, type AskpassWorkspace, type SshPromptBroker } from './ssh-prompts'
import { systemSpawnSsh } from './ssh-install/system'
import { closeMachineMaster, sshTargetOf, type SshMachineStore } from './ssh-machines'
import { UninstallRun, runSshUninstall } from './ssh-uninstall'

type ActiveUninstall = {
  run: UninstallRun
  abort: AbortController
  prompts: SshPromptBroker
  confirm: ((ok: boolean) => void) | null
}

export function registerServerSshUninstallIpc(options: {
  ipcMain: IpcMain
  getWindow: () => BrowserWindow | null
  store: SshMachineStore
  /** 桌面此刻登着的账号:只卸「这个人用 SSH 装上的」那几台,并在清单里标出「你」。 */
  currentUserId: () => Promise<string | null>
}): void {
  const runs = new Map<string, ActiveUninstall>()

  const push = (state: ServerUninstallState) => {
    const win = options.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(SERVER_SSH_MACHINES_CHANNELS.uninstallState, state)
  }

  options.ipcMain.handle(
    SERVER_SSH_MACHINES_CHANNELS.uninstallStart,
    async (_event, request: { deviceId?: unknown }): Promise<ServerUninstallStartResponse> => {
      const deviceId = typeof request?.deviceId === 'string' ? request.deviceId : ''
      const userId = await options.currentUserId().catch(() => null)
      const machine = userId ? options.store.list().find((m) => m.deviceId === deviceId && m.ownerUserId === userId) : undefined
      if (!machine) return { error: 'unknownMachine' }
      const target = sshTargetOf(machine)
      const runId = crypto.randomUUID()
      const abort = new AbortController()
      const run = new UninstallRun(runId, deviceId, machine.display, push)
      // 与添加机器同一套提问分类(指纹 / 密码 / 口令 / 验证码 / 提醒)与「再试一次」,界面也是同一张卡片。
      const prompts = createSshPromptBroker({ onPrompt: (prompt) => run.setPrompt(prompt), stopped: () => abort.signal.aborted })
      const active: ActiveUninstall = { run, abort, prompts, confirm: null }
      runs.set(runId, active)

      void (async () => {
        let workspace: AskpassWorkspace | null = null
        let env: NodeJS.ProcessEnv = process.env
        try {
          workspace = await openAskpassWorkspace(prompts.handler)
          env = { ...process.env, ...workspace.env }
          const final = await runSshUninstall(target, run, {
            spawnSsh: systemSpawnSsh(env),
            controlPath: workspaceControlPath(workspace.dir),
            currentUserId: userId,
            waitForConfirm: () =>
              new Promise<boolean>((resolve) => {
                if (abort.signal.aborted) return resolve(false)
                active.confirm = (ok) => {
                  active.confirm = null
                  resolve(ok)
                }
              }),
            signal: abort.signal,
          })
          // 装的东西都删了:这台桌面也不再记得怎么 SSH 过去(它的「编程」直连随之没有)。
          if (final.phase === 'done') {
            // 卸掉了:这台机器那条共享连接一并收掉(❌ 留一条认证过的连接挂在后台)。
            void closeMachineMaster(machine)
            options.store.forget(deviceId)
          }
        } catch (error) {
          if (run.snapshot().phase !== 'done' && run.snapshot().phase !== 'failed') {
            run.update((draft) => {
              draft.prompt = null
              draft.phase = 'failed'
              draft.failure = { reason: 'unknown', detail: error instanceof Error ? error.message : String(error) }
            })
          }
        } finally {
          prompts.cancelAll()
          active.confirm?.(false)
          const controlPath = workspace ? workspaceControlPath(workspace.dir) : null
          if (controlPath) {
            await new Promise<void>((resolve) => {
              const args = ['-o', `ControlPath=${controlPath}`, '-O', 'exit']
              if (target.port !== undefined) args.push('-p', String(target.port))
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
    },
  )

  options.ipcMain.handle(SERVER_SSH_MACHINES_CHANNELS.uninstallConfirm, (_event, runId: unknown) => {
    const active = runs.get(String(runId))
    if (!active?.confirm) return false
    active.confirm(true)
    return true
  })

  options.ipcMain.handle(SERVER_SSH_MACHINES_CHANNELS.uninstallCancel, (_event, runId: unknown) => {
    const active = runs.get(String(runId))
    if (!active) return false
    active.abort.abort()
    active.confirm?.(false)
    active.prompts.cancelAll()
    return true
  })

  options.ipcMain.handle(SERVER_SSH_MACHINES_CHANNELS.uninstallAnswer, (_event, answer: ServerUninstallAnswer) => {
    const active = runs.get(String(answer?.runId))
    if (!active) return false
    return active.prompts.answer(String(answer?.promptId), typeof answer.value === 'string' ? answer.value : null)
  })
}

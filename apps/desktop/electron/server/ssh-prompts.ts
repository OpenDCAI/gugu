/**
 * #6264 ssh 问人的那一套管道:添加机器、卸载、直连终端三处共用(behavior「要密码或密钥口令时在咕咕里问,❌ 卡住不动」)。
 *
 *  · openAskpassWorkspace:建一个只有本用户进得去的短目录,在里面起 askpass(见 ssh-askpass.ts),
 *    给出交给 ssh 子进程的环境变量;close 时收掉套接字、删目录。
 *  · createSshPromptBroker:askpass 递来的一句话 → 界面上的一张提问卡片(describePrompt 分类),
 *    等人回答 / 取消;同一句话这一轮里又问了一遍 = 上次的回答不对,卡片据此说「再试一次」;
 *    ssh 不等了(杀掉 askpass)卡片自己收起。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SshKeyInstallOutcome, SshPrompt } from '../../src/session/shared/ssh-prompt'
import type { DirectTerminalAskpass, SshPromptOutcome } from '../session/main/core/pty/direct-terminal/ssh-connect'
import { startAskpass, type AskpassHandler } from './ssh-askpass'
import { describePrompt } from './ssh-install/logic'

/** 一个提问是怎么收场的:人答了、人取消了、ssh 不等了(askpass 被杀 / 整件事被取消)。 */
export type { SshPromptOutcome }

export type SshPromptBroker = {
  /** 交给 startAskpass 的 handler。 */
  handler: AskpassHandler
  /**
   * 人回答了(value = null 是取消)。promptId 对不上 ⇒ false。
   * installKey:密码提问上勾了「以后不用再输密码」—— 记下这个密码,等调用方确认登上了再来取(takeKeyRequest)。
   */
  answer(promptId: string, value: string | null, extra?: { installKey?: boolean }): boolean
  /**
   * 连接登上之后调用方来取:这一轮最后答的那个密码勾没勾「下次免密」。取一次就清掉(密码只在内存里过这一手)。
   * 勾了之后又答了一次没勾的(第一次答错、第二次改了主意)= 以最后一次为准。
   */
  takeKeyRequest(): { password: string } | null
  /** 所有待答的一律当取消(整件事停了)。 */
  cancelAll(): void
  /** 新的一轮(直连终端的下一次连接):「又问了一遍」重新计。 */
  newRound(): void
  /** 此刻挂着的那一个。 */
  current(): SshPrompt | null
}

export function createSshPromptBroker(options: {
  /** 把密钥路径缩成 `~/…` 用。 */
  home?: string
  /** 此刻该挂的提问;null = 收起。 */
  onPrompt: (prompt: SshPrompt | null) => void
  /** 每个提问收场时(直连终端据此认出「人取消了」「没人回答」)。 */
  onSettled?: (prompt: SshPrompt, outcome: SshPromptOutcome) => void
  /** 整件事已经停了:新来的提问直接当取消,❌ 再弹卡片。 */
  stopped?: () => boolean
  newId?: () => string
  /** 这条连接登上之后能替人装钥匙(添加机器、直连终端、端口转发):密码提问带上 offerKeyInstall。卸载 ❌。 */
  offerKeyInstall?: boolean
}): SshPromptBroker {
  const home = options.home ?? os.homedir()
  const newId = options.newId ?? (() => crypto.randomUUID())
  const pending = new Map<string, (value: string | null, outcome: SshPromptOutcome) => void>()
  let asked = new Set<string>()
  let current: SshPrompt | null = null
  const kinds = new Map<string, SshPrompt['kind']>()
  let keyRequest: { password: string } | null = null

  const handler: AskpassHandler = ({ prompt: message, mode, signal }) =>
    new Promise<string | null>((resolve) => {
      if (options.stopped?.()) return resolve(null)
      const id = newId()
      const described = describePrompt(message, mode, home)
      const key = `${described.kind}|${described.subject ?? ''}|${described.label ?? ''}`
      const retry = described.kind !== 'hostKey' && described.kind !== 'notice' && asked.has(key)
      asked.add(key)
      const prompt: SshPrompt = {
        id,
        ...described,
        ...(retry ? { retry: true } : {}),
        ...(options.offerKeyInstall && described.kind === 'password' ? { offerKeyInstall: true } : {}),
      }
      kinds.set(id, prompt.kind)
      const settle = (value: string | null, outcome: SshPromptOutcome) => {
        if (!pending.has(id)) return
        pending.delete(id)
        kinds.delete(id)
        if (current?.id === id) {
          current = null
          options.onPrompt(null)
        }
        options.onSettled?.(prompt, outcome)
        resolve(value)
      }
      pending.set(id, settle)
      // 「请触碰安全密钥」这类提醒、以及 ssh 自己先放弃了(对方超时断开):askpass 被杀,卡片随之收起。
      signal.addEventListener('abort', () => settle(null, 'gone'), { once: true })
      current = prompt
      options.onPrompt(prompt)
    })

  return {
    handler,
    answer(promptId, value, extra) {
      const settle = pending.get(promptId)
      if (!settle) return false
      if (kinds.get(promptId) === 'password' && value !== null) {
        keyRequest = options.offerKeyInstall && extra?.installKey ? { password: value } : null
      }
      settle(value, value === null ? 'cancelled' : 'answered')
      return true
    },
    takeKeyRequest() {
      const request = keyRequest
      keyRequest = null
      return request
    },
    cancelAll() {
      for (const settle of [...pending.values()]) settle(null, 'gone')
    },
    newRound() {
      asked = new Set()
      keyRequest = null
    },
    current: () => current,
  }
}

export type AskpassWorkspace = {
  /** 只有本用户进得去的临时目录(也放 ControlMaster 套接字)。 */
  dir: string
  /** 交给 ssh 子进程的环境变量(SSH_ASKPASS、SSH_ASKPASS_REQUIRE=force …)。 */
  env: Record<string, string>
  close(): Promise<void>
}

/**
 * 目录要短(unix 套接字路径上限约 104 字节)、只有本用户进得去。
 * 起 askpass 失败时目录当场删掉,❌ 留一个空目录。
 */
export async function openAskpassWorkspace(handler: AskpassHandler): Promise<AskpassWorkspace> {
  const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'gugu-ssh-'))
  try {
    fs.chmodSync(dir, 0o700)
    const askpass = await startAskpass({ dir, nodeExecutable: process.execPath, handler })
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(askpass.env)) if (typeof value === 'string') env[key] = value
    let closed = false
    return {
      dir,
      env,
      close: async () => {
        if (closed) return
        closed = true
        await askpass.close()
        fs.rmSync(dir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

/** 放在工作目录里的 ControlMaster 套接字(Windows 自带的 OpenSSH 不支持)。 */
export function workspaceControlPath(dir: string): string | null {
  return process.platform === 'win32' ? null : path.join(dir, 'cm-%C')
}

/**
 * 直连终端的那一份:一条终端一个 askpass(自己的目录、自己的令牌),问题只回到这条终端上。
 * 形状对齐 DirectTerminalAskpass(electron/session/main/core/pty/direct-terminal);会话结束时由会话 close。
 */
export async function createTerminalAskpass(
  open: typeof openAskpassWorkspace = openAskpassWorkspace,
  /**
   * #6264「下次免密」:这条连接登上之后替人装钥匙(给了才在密码提问上出那个勾)。
   * 拿到的是人刚答的密码(复用不了已认证的连接时,装钥匙那一下重新登录要用);结果报给 onKeyInstall。
   */
  installKey?: (password: string) => Promise<SshKeyInstallOutcome>,
): Promise<DirectTerminalAskpass> {
  const promptListeners: Array<(prompt: SshPrompt | null) => void> = []
  const settledListeners: Array<(prompt: SshPrompt, outcome: SshPromptOutcome) => void> = []
  const keyListeners: Array<(outcome: SshKeyInstallOutcome) => void> = []
  let closed = false
  const broker = createSshPromptBroker({
    offerKeyInstall: Boolean(installKey),
    onPrompt: (prompt) => {
      for (const listener of promptListeners) listener(prompt)
    },
    onSettled: (prompt, outcome) => {
      for (const listener of settledListeners) listener(prompt, outcome)
    },
    stopped: () => closed,
  })
  const workspace = await open(broker.handler)
  return {
    env: workspace.env,
    onPrompt: (listener) => void promptListeners.push(listener),
    onSettled: (listener) => void settledListeners.push(listener),
    answer: (promptId, value, extra) => broker.answer(promptId, value, extra),
    // 连上了:这一轮勾过「下次免密」就去装。装的时候这条连接可能已经关了(端口转发转好就收 askpass),
    // 结果照样报给听的人 —— ❌ 因为 closed 就把「没做成」吞掉。
    authenticated: () => {
      const request = broker.takeKeyRequest()
      if (!request || !installKey) return
      void installKey(request.password)
        .catch((): SshKeyInstallOutcome => ({ status: 'failed', reason: 'unreachable' }))
        .then((outcome) => {
          for (const listener of keyListeners) listener(outcome)
        })
    },
    onKeyInstall: (listener) => void keyListeners.push(listener),
    newRound: () => broker.newRound(),
    cancelAll: () => broker.cancelAll(),
    close: async () => {
      closed = true
      broker.cancelAll()
      await workspace.close()
    },
  }
}

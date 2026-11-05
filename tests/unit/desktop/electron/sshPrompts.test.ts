// #6264 ssh 问人的那一套管道(electron/server/ssh-prompts.ts):添加机器、卸载、直连终端共用。
// 真起 askpass 的套接字、真跑 ssh 会执行的那个 askpass 脚本,走通「问 → 卡片 → 回答 → ssh 读到」整条往返。
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { awaitFact, awaitPending } from '../../../support/awaitFact'
import type { SshPrompt } from '../../../../apps/desktop/src/session/shared/ssh-prompt'
import {
  createSshPromptBroker,
  createTerminalAskpass,
  openAskpassWorkspace,
  type AskpassWorkspace,
  type SshPromptOutcome,
} from '../../../../apps/desktop/electron/server/ssh-prompts'

/** 像 ssh 那样执行 askpass:提示当参数,读它 stdout 的一行当回答。 */
function runAskpass(env: Record<string, string>, prompt: string, mode = '') {
  const child = spawn(env.SSH_ASKPASS!, [prompt], {
    env: { ...process.env, ...env, ...(mode ? { SSH_ASKPASS_PROMPT: mode } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => (stdout += String(chunk)))
  const done = new Promise<{ code: number | null; stdout: string }>((resolve) => child.on('close', (code) => resolve({ code, stdout })))
  return { child, done }
}

function nextPrompt(listeners: Array<(p: SshPrompt | null) => void>): Promise<SshPrompt> {
  return new Promise((resolve) => {
    const listener = (p: SshPrompt | null) => {
      if (!p) return
      listeners.splice(listeners.indexOf(listener), 1)
      resolve(p)
    }
    listeners.push(listener)
  })
}

const unix = process.platform === 'win32' ? describe.skip : describe

unix('ssh 提问的往返(真套接字、真 askpass 脚本)', () => {
  let workspace: AskpassWorkspace | null = null
  afterEach(async () => {
    await workspace?.close()
    workspace = null
  })

  function setup() {
    const listeners: Array<(p: SshPrompt | null) => void> = []
    const shown: Array<SshPrompt | null> = []
    const settled: Array<[string, SshPromptOutcome]> = []
    const settleWaiters: Array<() => void> = []
    const broker = createSshPromptBroker({
      home: '/home/alice',
      onPrompt: (p) => {
        shown.push(p)
        for (const l of [...listeners]) l(p)
      },
      onSettled: (p, outcome) => {
        settled.push([p.kind, outcome])
        for (const resolve of settleWaiters.splice(0)) resolve()
      },
    })
    /** 下一次「卡片收场」。要在触发它的动作之前取。 */
    const nextSettle = () => new Promise<void>((resolve) => { settleWaiters.push(resolve) })
    return { broker, listeners, shown, settled, nextSettle }
  }

  it('问 → 卡片 → 回答 → ssh 从 askpass 的 stdout 读到;卡片随之收起', async () => {
    const t = setup()
    workspace = await openAskpassWorkspace(t.broker.handler)
    expect(workspace.env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force' })
    const run = runAskpass(workspace.env, "alice@box's password: ")
    const prompt = await nextPrompt(t.listeners)
    expect(prompt).toMatchObject({ kind: 'password', subject: 'alice@box' })
    expect(prompt.retry).toBeUndefined()
    expect(t.broker.current()).toEqual(prompt)
    expect(t.broker.answer(prompt.id, 's3cret')).toBe(true)
    expect(await run.done).toEqual({ code: 0, stdout: 's3cret\n' })
    expect(t.broker.current()).toBeNull()
    expect(t.shown.at(-1)).toBeNull()
    expect(t.settled).toEqual([['password', 'answered']])
  })

  it('取消:askpass 以非零退出(ssh 当作没给口令 / 不认这台机器)', async () => {
    const t = setup()
    workspace = await openAskpassWorkspace(t.broker.handler)
    const run = runAskpass(workspace.env, "Enter passphrase for key '/home/alice/.ssh/id_ed25519': ")
    const prompt = await nextPrompt(t.listeners)
    expect(prompt).toMatchObject({ kind: 'passphrase', subject: '~/.ssh/id_ed25519' })
    t.broker.answer(prompt.id, null)
    expect((await run.done).code).not.toBe(0)
    expect(t.settled).toEqual([['passphrase', 'cancelled']])
  })

  it('同一句话这一轮又问了一遍 = 上次答错:卡片带「再试一次」;新的一轮重新计', async () => {
    const t = setup()
    workspace = await openAskpassWorkspace(t.broker.handler)
    const ask = async () => {
      const run = runAskpass(workspace!.env, "alice@box's password: ")
      const prompt = await nextPrompt(t.listeners)
      t.broker.answer(prompt.id, 'x')
      await run.done
      return prompt
    }
    expect((await ask()).retry).toBeUndefined()
    expect((await ask()).retry).toBe(true)
    t.broker.newRound()
    expect((await ask()).retry).toBeUndefined()
  })

  it('ssh 不等了(杀掉 askpass):卡片自己收起,记为「没等到回答」', async () => {
    const t = setup()
    workspace = await openAskpassWorkspace(t.broker.handler)
    const run = runAskpass(workspace.env, 'Confirm user presence for key ED25519-SK SHA256:abc', 'none')
    const prompt = await nextPrompt(t.listeners)
    expect(prompt.kind).toBe('notice')
    // 收场由 broker 自己报出来(套接字那头断了它才知道):等它报,❌ 10s 上限的轮询。
    const settledNow = t.nextSettle()
    run.child.kill('SIGKILL')
    await run.done
    await awaitPending('askpass 被杀后卡片收场', settledNow)
    expect(t.settled).toEqual([['notice', 'gone']])
    expect(t.broker.current()).toBeNull()
  })

  it('指纹提问:认成 hostKey,拆出主机与指纹;信任 = 回答 yes', async () => {
    const t = setup()
    workspace = await openAskpassWorkspace(t.broker.handler)
    const message =
      "The authenticity of host '[127.0.0.1]:2222 ([127.0.0.1]:2222)' can't be established.\n" +
      'ED25519 key fingerprint is SHA256:AbCdEf.\n' +
      'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
    const run = runAskpass(workspace.env, message, 'confirm')
    const prompt = await nextPrompt(t.listeners)
    expect(prompt).toMatchObject({ kind: 'hostKey', hostKey: { host: '[127.0.0.1]:2222', keyType: 'ED25519', fingerprint: 'SHA256:AbCdEf' } })
    t.broker.answer(prompt.id, 'yes')
    expect(await run.done).toEqual({ code: 0, stdout: 'yes\n' })
  })

  it('令牌不对不答(别的进程冒充 askpass)', async () => {
    const t = setup()
    workspace = await openAskpassWorkspace(t.broker.handler)
    const run = runAskpass({ ...workspace.env, GUGU_ASKPASS_TOKEN: 'forged' }, "alice@box's password: ")
    expect((await run.done).code).not.toBe(0)
    expect(t.shown).toEqual([])
  })
})

unix('createTerminalAskpass(直连终端的那一份)', () => {
  it('提问与收场都报给终端;关掉之后新来的提问直接当取消,❌ 再弹卡片', async () => {
    const terminal = await createTerminalAskpass()
    const prompts: Array<SshPrompt | null> = []
    const outcomes: SshPromptOutcome[] = []
    terminal.onPrompt((p) => prompts.push(p))
    terminal.onSettled((_p, o) => outcomes.push(o))
    const run = runAskpass(terminal.env, "alice@box's password: ")
    // 提问经真套接字从 askpass 进程过来:等它到,产出者(askpass)先退出就当场红,❌ 10s 上限。
    await awaitFact('提问到达终端', () => (prompts.length >= 1 ? true : undefined), { producer: run.child })
    expect(prompts).toHaveLength(1)
    expect(terminal.answer(prompts[0]!.id, 'pw')).toBe(true)
    expect(await run.done).toEqual({ code: 0, stdout: 'pw\n' })
    expect(outcomes).toEqual(['answered'])
    const waiting = runAskpass(terminal.env, "alice@box's password: ")
    await awaitFact('第二次提问到达终端', () => (prompts.length >= 3 ? true : undefined), { producer: waiting.child })
    expect(prompts).toHaveLength(3)
    await terminal.close()
    expect((await waiting.done).code).not.toBe(0)
    expect(outcomes).toEqual(['answered', 'gone'])
  })
})

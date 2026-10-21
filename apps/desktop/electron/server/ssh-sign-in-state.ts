/**
 * #6264 离线的 SSH 机器:问一句「这个账号在那台机器上还登着吗」(经同一条 SSH 读 `gugu-server status --json`)。
 * 答案决定设备行上写「离线」还是「登录已失效 · 重新登录」。连不上 / 那边太旧 = unknown,照旧只说离线。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SshSignInState } from '../../src/lib/serverSshMachines'
import type { SshTarget } from './ssh-install/logic'
import { parseStatusJson, type StatusReport } from './server-status'
import { sshBatchArgs } from './ssh-batch'

export function signInStateFrom(report: StatusReport | null, userId: string): SshSignInState {
  if (!report) return { state: 'unknown' }
  const account = report.accounts.find((a) => a.userId === userId)
  if (!account) return { state: 'signedOut' }
  if (account.signedIn) return { state: 'signedIn' }
  if (account.signedOut) return { state: account.signedOut.reason, at: account.signedOut.at }
  return { state: 'signedOut' }
}

export type SpawnStatusSsh = (args: string[]) => ChildProcessWithoutNullStreams

export function sshSignInState(options: {
  target: SshTarget
  controlPath: string | null
  userId: string
  timeoutMs?: number
  spawnSsh?: SpawnStatusSsh
}): Promise<SshSignInState> {
  const args = sshBatchArgs(options.target, 'exec ~/.local/bin/gugu-server status --json', options.controlPath)
  return new Promise((resolve) => {
    const child = (options.spawnSsh ?? ((a) => spawn('ssh', a, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })))(args)
    let stdout = ''
    let settled = false
    const done = (state: SshSignInState) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(state)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      done({ state: 'unknown' })
    }, options.timeoutMs ?? 15_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-65_536)
    })
    child.stderr.resume()
    child.stdin.end()
    child.on('error', () => done({ state: 'unknown' }))
    // 老 server 不认 --json:只打人话、没有标记 ⇒ unknown(照旧只说离线)。
    child.on('close', (code) => done(code === 0 ? signInStateFrom(parseStatusJson(stdout), options.userId) : { state: 'unknown' }))
  })
}

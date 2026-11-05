import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearSignedOutMark,
  readSignedOutMark,
  writeSignedOutMark,
  type ServerAccount,
} from '../../../../apps/desktop/electron/server/server-layout'
import {
  formatAccountLines,
  formatStatusJson,
  parseStatusJson,
  statusAccounts,
} from '../../../../apps/desktop/electron/server/server-status'
import { signInStateFrom } from '../../../../apps/desktop/electron/server/ssh-sign-in-state'
import { signInProbeKeys } from '../../../../apps/desktop/src/hooks/useSshSignInStates'

// #6264 server 登录失效 / 机器被移除:❌ 只显示「离线」,要说清发生了什么、去那台机器上做什么
// (照 VS Code Tunnels 的 `code tunnel user login` 提示、Tailscale 管理台的「Expired」)。
const account = (over: Partial<ServerAccount>): ServerAccount => ({
  userId: 'u1', email: 'a@b.c', addedAt: null, dir: '/x', dataDir: '/x/data', homeDir: '/x/home', signedIn: false, signedOut: null, ...over,
})

describe('被迫登出的记号', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-signed-out-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('写上、读回、重新登录后删掉', () => {
    expect(readSignedOutMark(dir)).toBeNull()
    writeSignedOutMark(dir, 'expired', new Date('2026-09-24T08:00:00Z'))
    expect(readSignedOutMark(dir)).toEqual({ reason: 'expired', at: '2026-09-24T08:00:00.000Z' })
    clearSignedOutMark(dir)
    expect(readSignedOutMark(dir)).toBeNull()
  })
})

describe('gugu-server status', () => {
  const accounts = [
    account({ userId: 'u1', email: 'on@x', signedIn: true }),
    account({ userId: 'u2', email: 'exp@x', signedOut: { reason: 'expired', at: '2026-09-24T08:00:00.000Z' } }),
    account({ userId: 'u3', email: 'rm@x', signedOut: { reason: 'removed', at: '2026-09-24T09:00:00.000Z' } }),
    account({ userId: 'u4', email: 'bye@x' }), // 自己 logout 的:不列
  ]

  it('人话:登着的、登录失效的、被移除的各说各的,并说该敲什么', () => {
    const lines = formatAccountLines(statusAccounts(accounts, () => true), () => 42)
    expect(lines).toEqual([
      '登录的账号:',
      '  on@x  在运行(进程 42)',
      // 远程隧道开放后(owner 2026-10-15),服务器上自己就能重新登录。
      '  exp@x  登录已失效(2026-09-24 08:00 起),重新登录:执行 gugu-server login',
      '  rm@x  已从账号移除(2026-09-24 09:00),重新登录:执行 gugu-server login',
    ])
  })

  it('--json 夹在标记之间,rc 横幅混进来也读得出;桌面据此判这个账号的状态', () => {
    const report = { version: '0.2.140', accounts: statusAccounts(accounts, () => true) }
    const parsed = parseStatusJson(`欢迎回来\n${formatStatusJson(report)}bye\n`)
    expect(parsed).toEqual(report)
    expect(signInStateFrom(parsed, 'u1')).toEqual({ state: 'signedIn' })
    expect(signInStateFrom(parsed, 'u2')).toEqual({ state: 'expired', at: '2026-09-24T08:00:00.000Z' })
    expect(signInStateFrom(parsed, 'u3')).toEqual({ state: 'removed', at: '2026-09-24T09:00:00.000Z' })
    expect(signInStateFrom(parsed, 'u4')).toEqual({ state: 'signedOut' })
    // 老 server 不认 --json:只有人话 ⇒ 问不到,照旧只说离线
    expect(signInStateFrom(parseStatusJson('登录的账号:\n  a@b 在运行'), 'u1')).toEqual({ state: 'unknown' })
  })
})

describe('设置 → 设备:问哪几台', () => {
  const device = (id: string, online: boolean, lastSeen = '2026-09-24T08:00:00Z') =>
    ({ device_id: id, is_online: online, is_current_device: false, last_seen_at: lastSeen }) as never
  it('只问离线的、记着怎么 SSH 过去的;同一段离线只问一次', () => {
    const address = (id: string) => (id === 'tunnel' ? null : `alice@${id}`)
    const keys = signInProbeKeys([device('a', false), device('b', true), device('tunnel', false)], address)
    expect([...keys.keys()]).toEqual(['a'])
    expect(signInProbeKeys([device('a', false)], address).get('a')).toBe(keys.get('a'))
    expect(signInProbeKeys([device('a', false, '2026-09-25T00:00:00Z')], address).get('a')).not.toBe(keys.get('a'))
  })
})

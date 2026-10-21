import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@gugu/core/cloud/config', () => ({
  getSupabaseAnonKey: () => 'public-anon-key',
  getSupabaseUrl: () => 'https://db.example.test',
}))

import {
  adoptedPlatformAccessForSession,
  claimPlatformAccessForThisProcess,
  issuePlatformModelAccess,
  processStartedAt,
  revokePlatformModelAccess,
  settleResidualPlatformModelAccess,
} from '../../../../apps/desktop/electron/model-access'

// #4467:签出去的平台票在进程外有一份账本,撤销成功才消失;没撤掉的,下次启动按账本结清。
const OWNER = 'owner-1'
const notRunning = async (): Promise<ReadonlySet<string>> => new Set()
const authProvider = { getAuth: async () => ({ accessToken: 'owner-jwt', userId: OWNER }) }
let home = ''
const ledger = (accessSessionId: string) => join(home, 'platform-access', `${accessSessionId}.json`)

/** 一个一定已经退出的 pid(自己起一个子进程等它结束),阳控见 settle 里「活 pid 不碰」那条。 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  return child.pid!
}

function seed(
  accessSessionId: string,
  fields: Partial<{ ownerUserId: string; pid: number; processStartedAt: string; issuedAt: string; detached: true; sessionId: string }> = {},
): void {
  mkdirSync(join(home, 'platform-access'), { recursive: true })
  writeFileSync(ledger(accessSessionId), JSON.stringify({
    accessSessionId, ownerUserId: OWNER, pid: deadPid(), processStartedAt: '2026-09-22T18:00:00.000Z',
    issuedAt: '2026-09-22T19:00:00.000Z', ...fields,
  }))
}

async function selfStartedAt(): Promise<string> {
  return new Date((await processStartedAt(process.pid))!).toISOString()
}

type ModelAccessBody = { action: string; session_id?: string }

function revokeCalls(calls: readonly unknown[][]): string[] {
  return calls
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as ModelAccessBody)
    .filter((body: ModelAccessBody) => body.action === 'revoke')
    .map((body: ModelAccessBody) => body.session_id!)
}

describe('#4467 平台票结清账本', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    home = mkdtempSync(join(tmpdir(), 'gugu-access-ledger-'))
    vi.stubEnv('GUGU_HOME', home)
  })

  it('records an issued session and drops it only after a successful revoke', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      session_id: 'access-1', relay_url: 'https://relay.test', token: 'secret-token', model: 'm',
      protocol: 'anthropic-messages', expires_at: '2026-09-22T20:00:00.000Z',
    })).mockResolvedValueOnce(Response.json({ charged_credits: 0 }))

    await issuePlatformModelAccess({
      authProvider, agentUserId: 'agent-1', engineId: 'claude', modelId: 'm', protocol: 'anthropic-messages',
      sessionId: 'conv-1',
    })
    const entry = JSON.parse(readFileSync(ledger('access-1'), 'utf8'))
    // 账本只有撤销需要的标识:能调网关的值(令牌、中转地址)一个都不落。
    expect(Object.keys(entry).sort()).toEqual(['accessSessionId', 'issuedAt', 'ownerUserId', 'pid', 'processStartedAt', 'sessionId'])
    expect(entry.processStartedAt).toBe(await selfStartedAt())
    expect(entry).toMatchObject({ accessSessionId: 'access-1', ownerUserId: OWNER, pid: process.pid, sessionId: 'conv-1' })
    const raw = readFileSync(ledger('access-1'), 'utf8')
    expect(raw).not.toContain('secret-token')
    expect(raw).not.toContain('relay.test')
    if (process.platform !== 'win32') expect(statSync(ledger('access-1')).mode & 0o777).toBe(0o600)

    await revokePlatformModelAccess(authProvider, 'access-1')
    expect(existsSync(ledger('access-1'))).toBe(false)
  })

  it('keeps the entry with the failure text when revoke fails, and rethrows', async () => {
    seed('access-2', { pid: process.pid, processStartedAt: await selfStartedAt() })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'gateway said no' }, { status: 400 }))

    await expect(revokePlatformModelAccess(authProvider, 'access-2')).rejects.toThrow('gateway said no')
    expect(JSON.parse(readFileSync(ledger('access-2'), 'utf8'))).toMatchObject({ lastRevokeError: 'gateway said no' })
  })

  it('settles residue from dead processes of the signed-in owner and leaves everything else', async () => {
    seed('dead-mine')
    seed('dead-mine-gone')
    seed('dead-mine-fails')
    seed('live-mine', { pid: process.pid, processStartedAt: await selfStartedAt() })
    seed('dead-other', { ownerUserId: 'owner-2' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { session_id } = JSON.parse(String((init as RequestInit).body)) as { session_id: string }
      if (session_id === 'dead-mine-gone') return Response.json({ error: 'model access session not found' }, { status: 404 })
      if (session_id === 'dead-mine-fails') return Response.json({ error: 'HTTP 429' }, { status: 400 })
      return Response.json({ charged_credits: 0 })
    })

    const result = await settleResidualPlatformModelAccess(authProvider, notRunning)

    expect(result.settled).toEqual(['dead-mine'])
    expect(result.unknown).toEqual(['dead-mine-gone'])
    expect(result.failed).toEqual([{ accessSessionId: 'dead-mine-fails', error: 'HTTP 429' }])
    expect(result.skipped).toBe(2)
    expect(revokeCalls(fetchMock.mock.calls).sort()).toEqual(['dead-mine', 'dead-mine-fails', 'dead-mine-gone'])
    expect(existsSync(ledger('dead-mine'))).toBe(false)
    expect(existsSync(ledger('dead-mine-gone'))).toBe(false)
    expect(existsSync(ledger('dead-mine-fails'))).toBe(true)
    expect(existsSync(ledger('live-mine'))).toBe(true)
    expect(existsSync(ledger('dead-other'))).toBe(true)
  })

  it('settles an entry whose pid now belongs to a different process start (pid reuse)', async () => {
    // 同一个 pid、启动时刻对不上 ⇒ 写账本的那个进程早没了,这个 pid 被复用了 ⇒ 结清。
    seed('reused-pid', { pid: process.pid, processStartedAt: '2026-01-01T00:00:00.000Z' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ charged_credits: 0 }))

    const result = await settleResidualPlatformModelAccess(authProvider, notRunning)

    expect(result.settled).toEqual(['reused-pid'])
    expect(revokeCalls(fetchMock.mock.calls)).toEqual(['reused-pid'])
  })

  it('leaves a ticket alone while its issuing process (same pid, same start) is still running', async () => {
    // 阴控:正在用的会话,它的票不能被「结清上一轮残留」误撤。用一个真实在跑的别的进程,走 OS 进程表判活。
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
    try {
      const startedAt = await processStartedAt(child.pid!)
      expect(startedAt).not.toBeNull()
      seed('live-other-process', { pid: child.pid!, processStartedAt: new Date(startedAt!).toISOString() })
      const fetchMock = vi.spyOn(globalThis, 'fetch')

      const result = await settleResidualPlatformModelAccess(authProvider, notRunning)

      expect(result).toMatchObject({ settled: [], failed: [], skipped: 1 })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(existsSync(ledger('live-other-process'))).toBe(true)
    } finally {
      child.kill()
    }
  })

  it('keeps settling past a corrupt ledger line and leaves that line for a human', async () => {
    seed('dead-ok')
    writeFileSync(join(home, 'platform-access', 'broken.json'), '{ not json')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ charged_credits: 0 }))

    const result = await settleResidualPlatformModelAccess(authProvider, notRunning)

    expect(result.settled).toEqual(['dead-ok'])
    expect(result.failed.map((it) => it.accessSessionId)).toEqual(['broken.json'])
    expect(existsSync(join(home, 'platform-access', 'broken.json'))).toBe(true)
  })

  it('fails loudly with both errors when a ticket can be neither recorded nor revoked', async () => {
    // 账本目录位置被一个普通文件占住 ⇒ 记不下;当场撤销也失败 ⇒ 这张票无人知晓,必须两个错一起抛。
    writeFileSync(join(home, 'platform-access'), 'occupied')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({
        session_id: 'orphan', relay_url: 'https://relay.test', token: 't', model: 'm',
        protocol: 'anthropic-messages', expires_at: '2026-09-22T20:00:00.000Z',
      }))
      .mockResolvedValueOnce(Response.json({ error: 'HTTP 429' }, { status: 429 }))

    const issued = issuePlatformModelAccess({
      authProvider, agentUserId: 'agent-1', engineId: 'claude', modelId: 'm', protocol: 'anthropic-messages',
    })
    await expect(issued).rejects.toBeInstanceOf(AggregateError)
    await expect(issued).rejects.toThrow(/orphan could not be recorded nor revoked/)
  })

  it('adopts a detached ticket whose tmux session is still running instead of revoking it', async () => {
    // detach 的意义是进程活得比宿主久:它的票由下次启动的宿主接回续期,❌ 撤掉让那一轮当场失败。
    seed('detached-live', { detached: true, sessionId: 'conv-live', issuedAt: new Date().toISOString() })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { action } = JSON.parse(String((init as RequestInit).body)) as { action: string }
      return action === 'renew'
        ? Response.json({ expires_at: new Date(Date.now() + 15 * 60_000).toISOString() })
        : Response.json({ charged_credits: 0 })
    })

    const result = await settleResidualPlatformModelAccess(authProvider, async () => new Set(['conv-live']))

    expect(result).toMatchObject({ adopted: ['detached-live'], settled: [] })
    expect(revokeCalls(fetchMock.mock.calls)).toEqual([])
    const entry = JSON.parse(readFileSync(ledger('detached-live'), 'utf8'))
    expect(entry).toMatchObject({ detached: true, pid: process.pid, processStartedAt: await selfStartedAt() })
    expect(adoptedPlatformAccessForSession('conv-live')).toMatchObject({ accessSessionId: 'detached-live' })
  })

  it('settles a detached ticket whose tmux session is gone, or that can no longer be renewed', async () => {
    seed('detached-dead', { detached: true, sessionId: 'conv-dead' })
    seed('detached-expired', { detached: true, sessionId: 'conv-expired' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { action } = JSON.parse(String((init as RequestInit).body)) as { action: string }
      return action === 'renew'
        ? Response.json({ error: 'model access session has already expired' }, { status: 400 })
        : Response.json({ charged_credits: 0 })
    })

    const result = await settleResidualPlatformModelAccess(authProvider, async () => new Set(['conv-expired']))

    expect(result.adopted).toEqual([])
    expect(result.settled.sort()).toEqual(['detached-dead', 'detached-expired'])
    expect(revokeCalls(fetchMock.mock.calls).sort()).toEqual(['detached-dead', 'detached-expired'])
  })

  it('keeps detached tickets when tmux cannot be read, instead of reading failure as nothing running', async () => {
    seed('detached-unknown', { detached: true, sessionId: 'conv-x' })
    seed('plain-dead')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ charged_credits: 0 }))
    const snapshot = vi.fn(async (): Promise<ReadonlySet<string>> => { throw new Error('cannot list tmux sessions') })

    const result = await settleResidualPlatformModelAccess(authProvider, snapshot)

    expect(result.settled).toEqual(['plain-dead'])
    expect(result.failed).toEqual([{ accessSessionId: 'detached-unknown', error: 'cannot list tmux sessions' }])
    expect(revokeCalls(fetchMock.mock.calls)).toEqual(['plain-dead'])
    expect(existsSync(ledger('detached-unknown'))).toBe(true)
    // 整次结清只取一次快照。
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it('#6264 a new host claims a ticket it restored (host-served tmux session): settle then leaves it alone', async () => {
    seed('restored', { detached: true, sessionId: 'conv-1' })
    await claimPlatformAccessForThisProcess('restored')
    const entry = JSON.parse(readFileSync(ledger('restored'), 'utf8')) as Record<string, unknown>
    expect(entry).toMatchObject({ pid: process.pid, processStartedAt: await selfStartedAt() })
    expect(entry.detached).toBeUndefined()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const result = await settleResidualPlatformModelAccess(authProvider, notRunning)
    expect(result).toMatchObject({ settled: [], skipped: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(claimPlatformAccessForThisProcess('never-issued')).rejects.toThrow('no platform access ledger entry')
  })

  it('is a no-op before anything was ever issued', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    expect(await settleResidualPlatformModelAccess(authProvider, notRunning)).toEqual({ settled: [], adopted: [], unknown: [], failed: [], skipped: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// #6264 GoTrue 的续期令牌用一次就作废:续期后的新令牌写不进盘(磁盘满)时不许丢 —— 一直重试直到写进去;
// 续期之前先把要写的那个文件在盘上占好位置,占不到就先不续期(盘上那枚仍然有效)。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-auth-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ''),
  },
}))

const {
  createSessionPersister,
  readStoredServerSession,
  reserveSessionSlot,
  SESSION_SLOT_BYTES,
  writeStoredServerSession,
} = await import('../../../../apps/desktop/electron/server/server-auth')
const { createRefreshingRuntimeAuthProvider } = await import('../../../../packages/core/src/cloud/runtimeAuthProvider')

afterEach(() => {
  for (const name of fs.readdirSync(userData)) fs.rmSync(path.join(userData, name), { force: true })
})

const tokens = (n: number) => ({ accessToken: `a${n}`, refreshToken: `r${n}` })

describe('续期后的登录态写不进盘也不丢', () => {
  it('写失败:留在手上、按时重试,写进去为止;后来的更新令牌覆盖手上那枚', () => {
    let fail = true
    const written: string[] = []
    let tick: () => void = () => undefined
    const onFailure = vi.fn()
    const onRecovered = vi.fn()
    const persister = createSessionPersister({
      write: (t) => {
        if (fail) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
        written.push(t.refreshToken)
      },
      onFailure,
      onRecovered,
      setTimer: (fn) => ((tick = fn), {}),
      clearTimer: () => undefined,
    })
    persister.persist(tokens(1))
    expect(persister.pending()).toBe(true)
    persister.persist(tokens(2))
    tick()
    expect(onFailure).toHaveBeenCalledTimes(3)
    fail = false
    tick()
    expect(written).toEqual(['r2'])
    expect(persister.pending()).toBe(false)
    expect(onRecovered).toHaveBeenCalledTimes(1)
  })

  it('先占位再续期:占好的文件被覆盖写、截到实际长度、再改名成正式文件', () => {
    reserveSessionSlot()
    const slot = path.join(userData, 'server-session.enc.next')
    expect(fs.statSync(slot).size).toBe(SESSION_SLOT_BYTES)
    writeStoredServerSession(tokens(7))
    expect(fs.existsSync(slot)).toBe(false)
    expect(readStoredServerSession()).toEqual(tokens(7))
    expect(fs.statSync(path.join(userData, 'server-session.enc')).mode & 0o777).toBe(0o600)
  })

  it('占不到位置(盘满)就不续期:不向 GoTrue 发请求,盘上那枚续期令牌不会被用掉', async () => {
    const fetchImpl = vi.fn()
    const provider = createRefreshingRuntimeAuthProvider({
      supabaseUrl: 'https://x.supabase.co',
      anonKey: 'anon',
      accessToken: 'expired.jwt.token',
      refreshToken: 'r0',
      fetchImpl,
      beforeRefresh: () => {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      },
    })
    await expect(provider.getAuth()).rejects.toThrow('no space')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

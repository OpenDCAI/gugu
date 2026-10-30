import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apply, enabled } = vi.hoisted(() => ({ apply: vi.fn(async () => {}), enabled: { value: true } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ search: { apply } }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/global-search/global-search-flag', () => ({
  globalSearchV3Enabled: () => enabled.value,
}))
import { feedChats, feedRemoved, feedRows } from '../../../../apps/desktop/src/lib/searchIndexFeed'

const desktopSrc = resolve(__dirname, '../../../../apps/desktop/src')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

beforeEach(() => { apply.mockClear(); enabled.value = true })

describe('search index feed', () => {
  it('is the only renderer module that writes the search index', () => {
    const writers = sources(desktopSrc).filter((path) => /\bsearch\.apply\(/.test(readFileSync(path, 'utf8')))
    expect(writers.map((path) => relative(desktopSrc, path))).toEqual(['lib/searchIndexFeed.ts'])
  })

  it('applies everything fed in one task as one list', async () => {
    const row = { id: 'm', chat_id: 'g' }
    await Promise.all([feedChats([{ id: 'g', kind: 'group', sourceChatId: null }]), feedRows([row]), feedRemoved(['x'])])
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith([
      { kind: 'chats', chats: [{ id: 'g', kind: 'group', sourceChatId: null }] },
      { kind: 'rows', rows: [row] },
      { kind: 'remove', ids: ['x'] },
    ])
  })

  it('writes nothing while global search is off', async () => {
    enabled.value = false
    await Promise.all([feedRows([{ id: 'm' }]), feedRemoved(['m']), feedChats([])])
    expect(apply).not.toHaveBeenCalled()
  })

  it('surfaces a failed write to the caller', async () => {
    apply.mockRejectedValueOnce(new Error('disk full'))
    await expect(feedRemoved(['m'])).rejects.toThrow('disk full')
  })
})

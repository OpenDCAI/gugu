import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHostLocalSessionSource } from '../../../../apps/desktop/electron/sessionpage/local-session-source'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('createHostLocalSessionSource', () => {
  it('aborts an active index read, drains it, and rejects work after disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-local-session-source-'))
    roots.push(root)
    const source = createHostLocalSessionSource(root)
    let readSettled = false
    const read = source.list({ mode: 'fresh' }).finally(() => {
      readSettled = true
    })

    const dispose = source.dispose()

    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    await expect(dispose).resolves.toBeUndefined()
    expect(readSettled).toBe(true)
    await expect(source.list({ mode: 'cached' })).rejects.toThrow(
      'Local session source is shutting down',
    )
  })

  it('shares one disposal while no index has been activated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-local-session-source-'))
    roots.push(root)
    const source = createHostLocalSessionSource(root)

    const first = source.dispose()
    const second = source.dispose()

    expect(second).toBe(first)
    await expect(first).resolves.toBeUndefined()
  })
})

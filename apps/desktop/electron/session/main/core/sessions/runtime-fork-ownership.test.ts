import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeRuntimeForkOwnershipForRuntimeSession,
  readRuntimeForkOwnership,
  recordRuntimeForkOwnership,
} from './runtime-fork-ownership'

describe('runtime fork ownership', () => {
  const homes: string[] = []

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
  })

  it('writes an atomic provider-neutral marker and closes it without deleting the tombstone', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'runtime-fork-owner-'))
    homes.push(home)
    const env = { GUGU_HOME: home }

    await recordRuntimeForkOwnership(
      {
      runtimeSessionId: 'view-1',
      sourceSessionId: 'conversation-1',
      forkedFromSessionId: 'conversation-1',
        provider: 'claude',
        providerSessionId: 'provider-1',
        workspaceId: 'workspace-1',
        cwd: '/repo/task',
      },
      env,
    )
    expect((await readRuntimeForkOwnership(env))[0]).toMatchObject({
      runtimeSessionId: 'view-1',
      providerSessionId: 'provider-1',
      status: 'active',
    })

    await closeRuntimeForkOwnershipForRuntimeSession('view-1', env)
    expect((await readRuntimeForkOwnership(env))[0]).toMatchObject({ status: 'closed' })
  })

  it('keeps concurrent runtime forks distinct even when a provider reuses its session id', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'runtime-fork-owner-distinct-'))
    homes.push(home)
    const env = { GUGU_HOME: home }
    const common = {
      sourceSessionId: 'conversation-1',
      provider: 'claude',
      providerSessionId: 'provider-shared',
      workspaceId: 'workspace-1',
      cwd: '/repo/task',
    }

    await recordRuntimeForkOwnership({ ...common, runtimeSessionId: 'view-a' }, env)
    await recordRuntimeForkOwnership({ ...common, runtimeSessionId: 'view-b' }, env)

    expect(await readRuntimeForkOwnership(env)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runtimeSessionId: 'view-a', status: 'active' }),
        expect.objectContaining({ runtimeSessionId: 'view-b', status: 'active' }),
      ]),
    )
    await closeRuntimeForkOwnershipForRuntimeSession('view-a', env)
    expect(await readRuntimeForkOwnership(env)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runtimeSessionId: 'view-a', status: 'closed' }),
        expect.objectContaining({ runtimeSessionId: 'view-b', status: 'active' }),
      ]),
    )
  })

  it('fails loud on a malformed marker instead of falling back to transcript heuristics', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'runtime-fork-owner-invalid-'))
    homes.push(home)
    const directory = path.join(home, 'runtime-fork-ownership')
    await mkdir(directory, { recursive: true })
    const marker = path.join(directory, 'broken.json')
    await writeFile(marker, '{"kind":"runtime-only-fork"}\n')
    await expect(readRuntimeForkOwnership({ GUGU_HOME: home })).rejects.toThrow(
      'Invalid runtime fork ownership marker',
    )
    await expect(readFile(marker, 'utf8')).resolves.toContain('runtime-only-fork')
  })
})

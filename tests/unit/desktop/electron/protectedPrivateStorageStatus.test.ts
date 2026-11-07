import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let directory: string
beforeEach(async () => {
  vi.resetModules()
  directory = await mkdtemp(join(tmpdir(), 'gugu-private-ready-'))
  vi.stubEnv('GUGU_HOME', join(directory, 'host-state'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

it('cannot claim protection before the trusted feature registers all its storage', async () => {
  const { protectedPrivateStorageStatus } = await import('@gugu/core/local/state/agentFileBoundary')
  expect(await protectedPrivateStorageStatus('vault')).toEqual({ status: 'unavailable', reason: 'not_registered' })
})

it('establishes the boundary before a future control file is created, and keeps snapshots immutable', async () => {
  const { registerProtectedPrivateStorage, protectedPrivateStorages } = await import('@gugu/core/local/state/protectedPrivateStorage')
  const { protectedPrivateStorageStatus, requireAgentFileAccess } = await import('@gugu/core/local/state/agentFileBoundary')
  const file = join(directory, 'private', 'switch.json')
  const paths = [file]
  const storage = { id: 'vault', paths }
  registerProtectedPrivateStorage(storage)
  paths[0] = join(directory, 'ordinary')
  storage.id = 'changed'
  expect(protectedPrivateStorages().find(item => item.id === 'vault')?.paths).toEqual([file])
  expect(await protectedPrivateStorageStatus('vault')).toEqual({ status: 'ready' })
  await expect(requireAgentFileAccess(file)).rejects.toThrow()
  expect(await protectedPrivateStorageStatus('changed')).toMatchObject({ status: 'unavailable' })
})

it('cannot override or withdraw a registration, including the built-in permission protection', async () => {
  const { registerProtectedPrivateStorage } = await import('@gugu/core/local/state/protectedPrivateStorage')
  const paths = [join(directory, 'private')]
  registerProtectedPrivateStorage({ id: 'vault', paths })
  for (const storage of [{ id: 'vault', paths }, { id: 'service-permissions', paths }, { id: 'empty', paths: [] }, { id: 'relative', paths: ['relative'] }]) {
    expect(() => registerProtectedPrivateStorage(storage)).toThrow()
  }
})

it('returns unavailable and refuses Agent access if registered protection cannot be resolved', async () => {
  const { registerProtectedPrivateStorage } = await import('@gugu/core/local/state/protectedPrivateStorage')
  const { protectedPrivateStorageStatus, requireAgentFileAccess } = await import('@gugu/core/local/state/agentFileBoundary')
  const cycle = join(directory, 'cycle')
  await symlink(cycle, cycle)
  registerProtectedPrivateStorage({ id: 'vault', paths: [cycle] })
  const ordinary = join(directory, 'ordinary')
  await writeFile(ordinary, 'ordinary')
  expect(await protectedPrivateStorageStatus('vault')).toEqual({ status: 'unavailable', reason: 'protection_unavailable' })
  await expect(requireAgentFileAccess(ordinary)).rejects.toThrow()
})

it('rechecks storage instead of retaining a stale ready result', async () => {
  const { registerProtectedPrivateStorage } = await import('@gugu/core/local/state/protectedPrivateStorage')
  const { protectedPrivateStorageStatus } = await import('@gugu/core/local/state/agentFileBoundary')
  const root = join(directory, 'private')
  await mkdir(root)
  registerProtectedPrivateStorage({ id: 'vault', paths: [root] })
  expect(await protectedPrivateStorageStatus('vault')).toEqual({ status: 'ready' })
  await rm(root, { recursive: true })
  await symlink(root, root)
  expect(await protectedPrivateStorageStatus('vault')).toEqual({ status: 'unavailable', reason: 'protection_unavailable' })
})

it('cannot register new locations after a file gateway has started using an earlier boundary', async () => {
  const { registerProtectedPrivateStorage } = await import('@gugu/core/local/state/protectedPrivateStorage')
  const { requireAgentFileAccess, protectedPrivateStorageStatus } = await import('@gugu/core/local/state/agentFileBoundary')
  await requireAgentFileAccess(join(directory, 'ordinary'))
  expect(() => registerProtectedPrivateStorage({ id: 'late', paths: [join(directory, 'late-private')] })).toThrow('before Agent file gateways start')
  expect(await protectedPrivateStorageStatus('late')).toEqual({ status: 'unavailable', reason: 'not_registered' })
})

it('protects the default vault root before initialization creates any files', async () => {
  const { PASSWORD_VAULT_STORAGE, privatePasswordVaultDirectory } = await import('@gugu/core/local/state/protectedPrivateStorage')
  const { protectedPrivateStorageStatus, requireAgentFileAccess } = await import('@gugu/core/local/state/agentFileBoundary')
  expect(await protectedPrivateStorageStatus(PASSWORD_VAULT_STORAGE)).toEqual({ status: 'ready' })
  await expect(requireAgentFileAccess(join(privatePasswordVaultDirectory(), 'future-control.json'))).rejects.toThrow()
})

it('refuses delegation of the filesystem root containing protected descendants', async () => {
  const { requireAgentFileTreeAccess } = await import('@gugu/core/local/state/agentFileBoundary')
  await expect(requireAgentFileTreeAccess(parse(directory).root)).rejects.toThrow('protected private storage')
})

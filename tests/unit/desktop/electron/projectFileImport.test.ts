import { constants } from 'node:fs'
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setCoreLoggerFactory } from '@gugu/core/log'
import { importProjectFile } from '../../../../apps/desktop/electron/projectFileImport'

const clone = vi.hoisted(() => vi.fn())
vi.mock('@gugu/core/local/childProcess', () => ({ execFile: clone }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, copyFile: vi.fn(fs.copyFile) }
})

let root: string, source: string, restoreLog: () => void
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const warn = vi.fn(), bytes = Buffer.from('snapshot content')
const platform = (value: string) => Object.defineProperty(process, 'platform', { ...originalPlatform, value })
const imported = () => importProjectFile(root, { path: source, name: 'snapshot.txt', size: bytes.length }, async () => null)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gugu-import-clone-'))
  source = join(root, 'original ; $ file.txt')
  await writeFile(source, bytes)
  vi.mocked(copyFile).mockClear(); clone.mockReset(); warn.mockClear()
  restoreLog = setCoreLoggerFactory(() => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }))
  platform('darwin')
  // Model cp's resulting bytes, not a real clone or filesystem allocation measurement.
  clone.mockImplementation((_bin: string, args: string[], callback: (error: Error | null) => void) => {
    void readFile(args[2]).then(data => writeFile(args[3], data, { flag: 'wx' })).then(() => callback(null), callback)
  })
})
afterEach(async () => {
  Object.defineProperty(process, 'platform', originalPlatform)
  restoreLog()
  expect(root.startsWith(join(tmpdir(), 'gugu-import-clone-'))).toBe(true)
  await rm(root, { recursive: true, force: true })
})

it('uses macOS cp arguments and keeps the published snapshot separate from later working-file edits', async () => {
  const target = await imported()
  expect(clone).toHaveBeenCalledExactlyOnceWith('/bin/cp', ['-c', '-n', source, target], expect.any(Function))
  expect(copyFile).not.toHaveBeenCalled()
  await writeFile(source, 'agent edit')
  expect(await readFile(target)).toEqual(bytes)
  expect(warn).not.toHaveBeenCalled()
})

it.each(['linux', 'win32'])('keeps the existing exclusive copy flags on %s', async os => {
  platform(os)
  const target = await imported()
  expect(clone).not.toHaveBeenCalled()
  expect(copyFile).toHaveBeenCalledExactlyOnceWith(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  expect(await readFile(target)).toEqual(bytes)
})

it('removes a partial clone before the exclusive fallback and logs the clone failure', async () => {
  clone.mockImplementation((_bin: string, args: string[], callback: (error: Error) => void) => {
    void writeFile(args[3], 'partial').then(() => callback(Object.assign(new Error('clone unavailable'), { code: 1, stderr: 'cp: clonefile failed: Cross-device link' })))
  })
  const target = await imported()
  expect(copyFile).toHaveBeenCalledExactlyOnceWith(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  expect(await readFile(target)).toEqual(bytes)
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ stderr: 'cp: clonefile failed: Cross-device link' }), expect.any(String))
})

it.each(['EACCES', 'ENOENT', 'ENOSPC'])('propagates %s from the ordinary copy and cleans its unpublished directory', async code => {
  clone.mockImplementation((_bin: string, _args: string[], callback: (error: Error) => void) => callback(Object.assign(new Error('clone failed'), { code: 1, stderr: 'cp failed' })))
  const error = Object.assign(new Error(code), { code })
  vi.mocked(copyFile).mockRejectedValueOnce(error)
  await expect(imported()).rejects.toBe(error)
  expect(await readdir(join(root, '.gugu/attachments'))).toEqual([])
  expect(await readFile(source)).toEqual(bytes)
})

it('propagates a failure to start cp instead of treating it as unavailable cloning', async () => {
  const error = Object.assign(new Error('spawn failed'), { code: 'ENOENT' })
  clone.mockImplementation((_bin: string, _args: string[], callback: (error: Error) => void) => callback(error))
  await expect(imported()).rejects.toBe(error)
  expect(copyFile).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
})

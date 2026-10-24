import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it.skipIf(process.platform === 'win32')('exports a verified managed release and refuses custom or mismatched launchers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-runtime-export-')); roots.push(root)
  const dir = join(root, 'agents', 'mise-bin'); await mkdir(dir, { recursive: true })
  const launcher = join(dir, 'claude'), output = join(root, 'manifest.json')
  const run = (file: string) => promisify(execFile)(process.execPath, [resolve('scripts/export-assistant-runtime.mjs'), '--launcher', file, '--output', output, '--client-sha', 'a'.repeat(40)])
  await writeFile(launcher, '#!/bin/sh\n# gugu-release: 2.1.308\nprintf "2.1.308 (Claude Code)\\n"\n', { mode: 0o700 })
  await run(launcher)
  expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ format: 1, claude: '2.1.308', client_sha: 'a'.repeat(40), source: 'gugu-managed-runtime' })
  const custom = join(root, 'claude'); await writeFile(custom, await readFile(launcher), { mode: 0o700 })
  await expect(run(custom)).rejects.toThrow('Only the Gugu-managed')
  await writeFile(launcher, '#!/bin/sh\n# gugu-release: 2.1.300\nprintf "2.1.308 (Claude Code)\\n"\n')
  await expect(run(launcher)).rejects.toThrow('differs from the executable')
})

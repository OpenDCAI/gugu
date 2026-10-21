import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error The artifact publisher is a plain ESM script without a declaration file.
import { publishLocal } from '../../../scripts/e2e-artifact-store.mjs'

const roots: string[] = []
const scriptUrl = pathToFileURL(join(process.cwd(), 'scripts/e2e-artifact-store.mjs')).href

function fixture(session: string, directory: string) {
  const root = mkdtempSync(join(tmpdir(), 'gugu-e2e-artifact-4580-'))
  roots.push(root)
  const staged = join(root, 'staged')
  const payload = join(staged, directory)
  mkdirSync(payload, { recursive: true })
  writeFileSync(join(payload, 'MANIFEST.json'), `${JSON.stringify({ schema: 1, tag: 'pr-1-run-abc', session })}\n`)
  writeFileSync(join(payload, 'package.dmg'), `payload-${session}`)
  return { root, staged, payload }
}

function runChild(args: { store: string; staged: string; directory: string }) {
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { publishLocal } from ${JSON.stringify(scriptUrl)}; publishLocal(JSON.parse(process.env.GUGU_ARGS));`], {
      env: { ...process.env, GUGU_ARGS: JSON.stringify(args) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }))
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('e2e artifact store publication (#4580)', () => {
  it('serializes concurrent publications and keeps both ledgers', async () => {
    const store = mkdtempSync(join(tmpdir(), 'gugu-e2e-artifact-store-4580-'))
    roots.push(store)
    const first = fixture('github-actions-abc-1', 'entry-a')
    const second = fixture('github-actions-def-1', 'entry-b')
    const [a, b] = await Promise.all([
      runChild({ store, staged: first.staged, directory: 'entry-a' }),
      runChild({ store, staged: second.staged, directory: 'entry-b' }),
    ])
    expect(a).toMatchObject({ code: 0 })
    expect(b).toMatchObject({ code: 0 })
    expect(readFileSync(join(store, 'artifacts/entry-a/MANIFEST.json'), 'utf8')).toContain('github-actions-abc-1')
    expect(readFileSync(join(store, 'artifacts/entry-b/MANIFEST.json'), 'utf8')).toContain('github-actions-def-1')
    expect(execFileSync('git', ['-C', store, 'ls-files', 'artifacts'], { encoding: 'utf8' })).toContain('entry-a/MANIFEST.json')
    expect(execFileSync('git', ['-C', store, 'ls-files', 'artifacts'], { encoding: 'utf8' })).toContain('entry-b/MANIFEST.json')
  })

  it('reclaims an untracked same-run half-finished directory', () => {
    const store = mkdtempSync(join(tmpdir(), 'gugu-e2e-artifact-store-4580-'))
    roots.push(store)
    const old = fixture('github-actions-abc-1', 'entry')
    const incoming = fixture('github-actions-abc-2', 'entry')
    mkdirSync(join(store, 'artifacts/entry'), { recursive: true })
    writeFileSync(join(store, 'artifacts/entry/MANIFEST.json'), readFileSync(join(old.payload, 'MANIFEST.json')))
    publishLocal({ store, staged: incoming.staged, directory: 'entry' })
    expect(readFileSync(join(store, 'artifacts/entry/MANIFEST.json'), 'utf8')).toContain('github-actions-abc-2')
    expect(statSync(join(store, 'artifacts/entry/package.dmg')).isFile()).toBe(true)
  })

  it('commits an identical untracked residue instead of treating it as complete', () => {
    const store = mkdtempSync(join(tmpdir(), 'gugu-e2e-artifact-store-4580-'))
    roots.push(store)
    const incoming = fixture('github-actions-abc-2', 'entry')
    mkdirSync(join(store, 'artifacts/entry'), { recursive: true })
    for (const name of ['MANIFEST.json', 'package.dmg']) {
      writeFileSync(join(store, 'artifacts/entry', name), readFileSync(join(incoming.payload, name)))
    }
    publishLocal({ store, staged: incoming.staged, directory: 'entry' })
    expect(execFileSync('git', ['-C', store, 'ls-files', '--error-unmatch', '--', 'artifacts/entry'], { encoding: 'utf8' })).toContain('artifacts/entry/MANIFEST.json')
  })

  it('rejects a different-run conflict and releases the lock', () => {
    const store = mkdtempSync(join(tmpdir(), 'gugu-e2e-artifact-store-4580-'))
    roots.push(store)
    const old = fixture('github-actions-other-1', 'entry')
    const incoming = fixture('github-actions-abc-2', 'entry')
    mkdirSync(join(store, 'artifacts/entry'), { recursive: true })
    const oldManifest = readFileSync(join(old.payload, 'MANIFEST.json'), 'utf8')
    writeFileSync(join(store, 'artifacts/entry/MANIFEST.json'), oldManifest)
    expect(() => publishLocal({ store, staged: incoming.staged, directory: 'entry' })).toThrow('refusing to overwrite conflicting artifact ledger')
    expect(readFileSync(join(store, 'artifacts/entry/MANIFEST.json'), 'utf8')).toBe(oldManifest)
    expect(() => statSync(join(store, '.publish.lock'))).toThrow()
  })

  it('reclaims a stale lock left by a dead publisher', () => {
    const store = mkdtempSync(join(tmpdir(), 'gugu-e2e-artifact-store-4580-'))
    roots.push(store)
    const incoming = fixture('github-actions-abc-2', 'entry')
    const lock = join(store, '.publish.lock')
    writeFileSync(lock, JSON.stringify({ pid: 999999, host: 'dead-host', token: 'stale' }))
    const old = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(lock, old, old)
    publishLocal({ store, staged: incoming.staged, directory: 'entry' })
    expect(statSync(join(store, 'artifacts/entry/MANIFEST.json')).isFile()).toBe(true)
    expect(() => statSync(lock)).toThrow()
  })
})

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const repoRoot = path.resolve(__dirname, '../../..')
const sourceScript = path.join(repoRoot, 'scripts/build-psmux-bundle.mjs')
const bundleNames = ['tmux.exe', 'psmux.exe', 'pmux.exe', 'LICENSE', 'README.md']
const tempRoots: string[] = []

function fixture(missing?: string) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-psmux-bundle-'))
  tempRoots.push(tempRoot)
  const workspace = path.join(tempRoot, 'workspace')
  const scriptsDir = path.join(workspace, 'scripts')
  const overrideDir = path.join(tempRoot, 'override')
  fs.mkdirSync(scriptsDir, { recursive: true })
  fs.mkdirSync(overrideDir, { recursive: true })
  fs.copyFileSync(sourceScript, path.join(scriptsDir, 'build-psmux-bundle.mjs'))
  for (const name of bundleNames) {
    if (name !== missing) fs.writeFileSync(path.join(overrideDir, name), `fixture:${name}`)
  }
  return { workspace, overrideDir }
}

function runBundle(workspace: string, override: string) {
  return spawnSync(process.execPath, [path.join(workspace, 'scripts/build-psmux-bundle.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, GUGU_BUNDLE_PSMUX: override }
  })
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('psmux bundle override', () => {
  test('copies the complete verified artifact bundle', () => {
    const { workspace, overrideDir } = fixture()
    const result = runBundle(workspace, overrideDir)

    expect(result.status).toBe(0)
    for (const name of bundleNames) {
      expect(fs.readFileSync(path.join(workspace, 'psmux-bundle', name), 'utf8')).toBe(
        `fixture:${name}`
      )
    }
  })

  test('fails loud when the handed-off bundle is incomplete', () => {
    const { workspace, overrideDir } = fixture('LICENSE')
    const result = runBundle(workspace, overrideDir)

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('psmux override missing LICENSE')
  })

  test('keeps the single tmux.exe override compatible', () => {
    const { workspace, overrideDir } = fixture()
    const overrideFile = path.join(overrideDir, 'tmux.exe')
    const result = runBundle(workspace, overrideFile)

    expect(result.status).toBe(0)
    expect(fs.readFileSync(path.join(workspace, 'psmux-bundle', 'tmux.exe'), 'utf8')).toBe(
      'fixture:tmux.exe'
    )
    expect(fs.readdirSync(path.join(workspace, 'psmux-bundle'))).toEqual(['tmux.exe'])
  })
})

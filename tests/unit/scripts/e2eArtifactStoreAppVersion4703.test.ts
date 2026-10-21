import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error plain ESM script without a declaration file
import { artifactDirectoryName, assertAppVersionInArtifacts, parseArgs, publishLocal, requireAppVersion } from '../../../scripts/e2e-artifact-store.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// #4703 dogfood 构建把 `<base>-beta.<run>.<attempt>` 盖进包里,归档前恢复 package.json 让 checkout 干净,
// 版本改由 --app-version 显式入账。这里钉:选项被解析、坏版本 fail loud、目录名用的是传入的版本
// (同一 commit 不同 run 才不会撞同一目录)。

describe('e2e-artifact-store --app-version (#4703)', () => {
  it('parses --app-version and leaves it undefined when absent', () => {
    expect(parseArgs(['publish', '--skip-build', '--app-version', '0.2.36-beta.594.1'])).toMatchObject({
      command: 'publish',
      skipBuild: true,
      appVersion: '0.2.36-beta.594.1',
    })
    expect(parseArgs(['publish']).appVersion).toBeUndefined()
  })

  it('accepts x.y.z and x.y.z-prerelease, rejects anything else loudly', () => {
    expect(requireAppVersion('0.2.36')).toBe('0.2.36')
    expect(requireAppVersion('0.2.36-beta.594.1')).toBe('0.2.36-beta.594.1')
    for (const bad of ['', 'v0.2.36', '0.2', '0.2.36+meta', 'latest', undefined]) {
      expect(() => requireAppVersion(bad)).toThrow(/invalid --app-version/)
    }
  })

  it('refuses an --app-version that no installer name carries (the ledger must describe the stored package)', () => {
    const files = ['/r/gugu-beta-0.2.36-beta.596.1-arm64.dmg', '/r/gugu-beta-0.2.36-beta.596.1-arm64.dmg.blockmap']
    expect(assertAppVersionInArtifacts(files, '0.2.36-beta.596.1')).toBe('0.2.36-beta.596.1')
    expect(() => assertAppVersionInArtifacts(files, '0.2.36-beta.597.1')).toThrow(/does not appear in any installer name/)
    // the blockmap alone must not satisfy it
    expect(() => assertAppVersionInArtifacts(['/r/gugu-beta-0.2.36-beta.596.1-arm64.dmg.blockmap'], '0.2.36-beta.596.1')).toThrow(/does not appear/)
  })

  it('lands a local publication by one rename: no .incoming-* survives and the entry is tracked', () => {
    const store = mkdtempSync(join(tmpdir(), 'gugu-store-atomic-'))
    roots.push(store)
    const staged = mkdtempSync(join(tmpdir(), 'gugu-staged-atomic-'))
    roots.push(staged)
    const directory = '0.2.36-beta.1.1-aaaaaaaaaa-github-a'
    mkdirSync(join(staged, directory))
    writeFileSync(join(staged, directory, 'MANIFEST.json'), `${JSON.stringify({ schema: 1, tag: 'beta-aaaaaaaaaa', session: 'github-actions-1-1' })}\n`)
    writeFileSync(join(staged, directory, 'gugu-beta-0.2.36-beta.1.1-arm64.dmg'), 'bytes')

    const destination = publishLocal({ store, staged, directory })

    expect(destination).toBe(join(store, 'artifacts', directory))
    expect(existsSync(join(destination, 'gugu-beta-0.2.36-beta.1.1-arm64.dmg'))).toBe(true)
    expect(readdirSync(join(store, 'artifacts')).filter((name) => name.startsWith('.incoming-'))).toEqual([])
    const tracked = execFileSync('git', ['ls-files', '--', `artifacts/${directory}`], { cwd: store, encoding: 'utf8' }).trim().split('\n')
    expect(tracked.sort()).toEqual([`artifacts/${directory}/MANIFEST.json`, `artifacts/${directory}/gugu-beta-0.2.36-beta.1.1-arm64.dmg`])
  })

  it('names the archive directory after the shipped version, so reruns of one commit never collide', () => {
    const commit = 'e1e9913803d0d1019bf8816b417f8145add85a84'
    const a = artifactDirectoryName({ appVersion: '0.2.36-beta.594.1', commit, session: 'github-actions-1-1' })
    const b = artifactDirectoryName({ appVersion: '0.2.36-beta.595.1', commit, session: 'github-actions-2-1' })
    expect(a).toBe('0.2.36-beta.594.1-e1e9913803-github-a')
    expect(a).not.toBe(b)
    // 阴性对照:不带版本戳(PR CI 的形状)时同一 commit 的两次 run 确实会撞同一目录 —— 这正是 dogfood 要盖版本号的原因。
    expect(artifactDirectoryName({ appVersion: '0.2.36', commit, session: 'github-actions-1-1' })).toBe(
      artifactDirectoryName({ appVersion: '0.2.36', commit, session: 'github-actions-2-1' }),
    )
  })
})

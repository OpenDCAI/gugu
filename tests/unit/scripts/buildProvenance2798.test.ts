import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const checker = resolve('scripts/build-provenance.mjs')
const fixtures: string[] = []

function write(path: string, value: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, value)
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'gugu-provenance-'))
  fixtures.push(root)
  write(join(root, '.gitignore'), 'dist\napps/desktop/dist-electron\n')
  write(join(root, 'package.json'), '{"name":"provenance-fixture"}\n')
  write(join(root, 'apps/desktop/src/App.tsx'), 'export const state = "S1"\n')
  write(join(root, 'apps/desktop/dist-electron/main.js'), 'complete main artifact\n')
  write(
    join(root, 'apps/desktop/dist-electron/emdash-main-bridge.js'),
    'exports.setLocalSessionDeliveryBridge = function setLocalSessionDeliveryBridge() {}\n',
  )
  write(join(root, 'apps/desktop/dist-electron/preload.js'), 'contextBridge.exposeInMainWorld("electronAPI", {})\n')
  write(join(root, 'dist/index.html'), '<script type="module" src="/assets/index-S1.js"></script>\n')
  write(join(root, 'dist/assets/index-S1.js'), 'complete renderer artifact S1\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'provenance@example.test'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Provenance Test'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'S1'], { cwd: root })
  return root
}

function run(root: string, flag: '--write' | '--check') {
  return spawnSync(process.execPath, [checker, flag], { cwd: root, encoding: 'utf8' })
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('#2798 Electron E2E build provenance', () => {
  it('fails closed when complete artifacts predate the provenance manifest', () => {
    const root = fixture()
    const checked = run(root, '--check')
    expect(checked.status).toBe(1)
    expect(checked.stderr).toContain('build manifest is missing')
    expect(checked.stderr).toContain('artifacts have no source identity and are too old')
    expect(checked.stderr).toContain('repair: pnpm build:app')
  })

  it('allows complete fresh artifacts up to the Electron launch boundary', () => {
    const root = fixture()
    expect(run(root, '--write').status).toBe(0)
    const checked = run(root, '--check')
    expect(checked.status).toBe(0)
    expect(checked.stdout).toContain('[e2e provenance] launch allowed')
    expect(checked.stdout).toContain('renderer=/assets/index-S1.js')
    expect(checked.stdout).toContain('preload-symbol=electronAPI')
  })

  it('allows a fresh build from uncommitted source content', () => {
    const root = fixture()
    write(join(root, 'apps/desktop/src/App.tsx'), 'export const state = "S2 dirty but built"\n')
    expect(run(root, '--write').status).toBe(0)

    const checked = run(root, '--check')
    expect(checked.status).toBe(0)
    expect(checked.stdout).toContain('[e2e provenance] launch allowed')
    expect(checked.stdout).toMatch(/[0-9a-f]{40}\+dirty/)
  })

  it('refuses a complete S1 artifact set after source moves to S2 without rebuilding', () => {
    const root = fixture()
    expect(run(root, '--write').status).toBe(0)
    write(join(root, 'apps/desktop/src/App.tsx'), 'export const state = "S2"\n')

    const checked = run(root, '--check')
    expect(checked.status).toBe(1)
    expect(checked.stderr).toContain('refusing to launch Electron')
    expect(checked.stderr).toContain('source fingerprint differs')
    expect(checked.stderr).toMatch(/artifact source: [0-9a-f]{40}/)
    expect(checked.stderr).toMatch(/current source: [0-9a-f]{40}\+dirty/)
    expect(checked.stderr).toContain('repair: pnpm build:app')
  })

  it('hashes the renderer script actually referenced by index.html', () => {
    const root = fixture()
    expect(run(root, '--write').status).toBe(0)
    write(join(root, 'dist/assets/index-other.js'), 'different but complete renderer artifact\n')
    write(join(root, 'dist/index.html'), '<script type="module" src="/assets/index-other.js"></script>\n')

    const checked = run(root, '--check')
    expect(checked.status).toBe(1)
    expect(checked.stderr).toContain('index artifact differs')
    expect(checked.stderr).toContain('renderer artifact differs')
    expect(checked.stderr).toContain('index loads /assets/index-other.js')

    const manifest = JSON.parse(readFileSync(join(root, 'dist/gugu-build-provenance.json'), 'utf8'))
    expect(manifest.rendererScript).toBe('/assets/index-S1.js')
  })

  it('refuses a stale taskpage bridge even when the other Electron artifacts match', () => {
    const root = fixture()
    expect(run(root, '--write').status).toBe(0)
    write(
      join(root, 'apps/desktop/dist-electron/emdash-main-bridge.js'),
      'exports.setLocalSessionDeliveryBridge = function staleBridge() {}\n',
    )

    const checked = run(root, '--check')
    expect(checked.status).toBe(1)
    expect(checked.stderr).toContain('sessionpageBridge artifact differs')
  })
})

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = path.resolve(import.meta.dirname, '../../../scripts/dev/dev-app.sh')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

// 运行真实入口，以仪器替换 pnpm，检查最终子进程环境；不启动桌面或触碰日用实例。
function fixture(name = 'gugu') {
  const root = mkdtempSync(path.join(tmpdir(), 'gugu-dev-app-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet', root])
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }))
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'pnpm'), `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.GUGU_LAUNCH_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), home: process.env.GUGU_HOME,
  userData: process.env.GUGU_USER_DATA_DIR, electronAsNode: process.env.ELECTRON_RUN_AS_NODE
}))
process.exit(Number(process.env.GUGU_STUB_EXIT || 0))
`, { mode: 0o755 })
  const capture = path.join(root, 'capture.json')
  return {
    run(args: string[] = [], extra: Record<string, string> = {}) {
      return spawnSync('bash', [script, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          GUGU_DB_TARGET: 'local',
          GUGU_HOME: '/daily/home',
          GUGU_USER_DATA_DIR: '/daily/user-data',
          ELECTRON_RUN_AS_NODE: '1',
          GUGU_DEV_HOME: '',
          GUGU_DEV_USER_DATA_DIR: '',
          GUGU_DEV_LOG: path.join(root, 'dev.log'),
          GUGU_LAUNCH_CAPTURE: capture,
          ...extra,
        },
      })
    },
    captured: () => JSON.parse(readFileSync(capture, 'utf8')) as {
      args: string[]; home: string; userData: string; electronAsNode?: string
    },
  }
}

describe('public development entry point', () => {
  it('overrides inherited daily paths in the launched process and propagates failure', () => {
    const rig = fixture()
    expect(rig.run([], { GUGU_STUB_EXIT: '7' }).status).toBe(7)
    const child = rig.captured()
    expect(child.args).toEqual(['dev'])
    expect(child.home).toMatch(/\.gugu-dev-[a-f0-9]{8}\/home$/)
    expect(child.userData).toMatch(/\.gugu-dev-[a-f0-9]{8}\/user-data$/)
    expect(child.home).not.toBe('/daily/home')
    expect(child.userData).not.toBe('/daily/user-data')
    expect(child.electronAsNode).toBeUndefined()
  })

  it('uses explicit development overrides for the web entry point', () => {
    const rig = fixture()
    expect(rig.run(['--web'], {
      GUGU_DEV_HOME: '/isolated/home', GUGU_DEV_USER_DATA_DIR: '/isolated/user-data',
    }).status).toBe(0)
    expect(rig.captured()).toEqual({
      args: ['dev:web'], home: '/isolated/home', userData: '/isolated/user-data',
    })
  })

  it('rejects other repositories before launching pnpm', () => {
    const result = fixture('other-project').run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('当前 checkout 不是 Gugu')
  })
})

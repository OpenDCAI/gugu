import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const repoRoot = path.resolve(__dirname, '../../..')
const require_ = createRequire(import.meta.url)
const { resolveElectronFuses } = require_('../../../scripts/build/electron-fuses.cjs') as {
  resolveElectronFuses: (input: { tier: string }) => Record<string, boolean | undefined>
}

type BuilderConfig = { asar: boolean; electronFuses: Record<string, boolean | undefined> }
// electron-builder.cjs 在 require 时按 GUGU_TIER 定型,换 tier 必须清掉 Node 的模块缓存重新求值。
function loadBuilderConfig(tier: string): BuilderConfig {
  const file = path.join(repoRoot, 'electron-builder.cjs')
  vi.stubEnv('GUGU_TIER', tier)
  delete require_.cache[file]
  try {
    return require_(file) as BuilderConfig
  } finally {
    delete require_.cache[file]
  }
}

afterEach(() => vi.unstubAllEnvs())

const TIERS = ['production', 'beta', 'acceptance-abc123']

// @@@7195 Electron Fuses。决策与「为什么没翻」的清单在 scripts/build/electron-fuses.cjs;这里只钉**危险的翻法**,
// 不钉实现本身 —— 每一条都对应「翻了就坏」的真实后果。
describe('Electron Fuses(#7195)', () => {
  test('正式版关掉 --inspect / SIGUSR1;beta 与验收包保留,dogfood 排障要用', () => {
    expect(resolveElectronFuses({ tier: 'production' }).enableNodeCliInspectArguments).toBe(false)
    expect(resolveElectronFuses({ tier: 'beta' }).enableNodeCliInspectArguments).toBe(true)
    expect(resolveElectronFuses({ tier: 'acceptance-abc123' }).enableNodeCliInspectArguments).toBe(true)
  })

  test.each(TIERS)('%s:runAsNode 必须开着 —— ELECTRON_RUN_AS_NODE 在本产品里承重', (tier) => {
    expect(resolveElectronFuses({ tier }).runAsNode).toBe(true)
  })

  test('runAsNode 的承重方还在;哪天它们都没了,这条先红,提醒你回来重判这个 fuse', () => {
    for (const rel of [
      'apps/desktop/electron/engine-downloader.ts', // 用 Electron 当 node 跑随包的 npm
      'apps/desktop/electron/session-host-entry.ts', // 会话宿主进程
      'apps/desktop/electron/server/ssh-askpass.ts', // ssh askpass 小脚本
    ]) {
      expect(fs.readFileSync(path.join(repoRoot, rel), 'utf8'), rel).toContain('ELECTRON_RUN_AS_NODE')
    }
  })

  test.each(TIERS)('%s:带「翻了就坏」后果的 fuse 一个都不许被打开或关掉', (tier) => {
    const fuses = resolveElectronFuses({ tier })
    for (const key of [
      'enableNodeOptionsEnvironmentVariable', // 同管 NODE_EXTRA_CA_CERTS,关了用户代理证书失效
      'grantFileProtocolExtraPrivileges', // extension-look-picture.ts 走 loadFile(file://)
      'onlyLoadAppFromAsar', // asar:false 下找不到 app 代码
      'enableEmbeddedAsarIntegrityValidation', // 同上,前提是 asar
      'enableCookieEncryption', // 单向迁移,另议
      'loadBrowserProcessSpecificV8Snapshot',
    ]) {
      expect(fuses[key], key).toBeUndefined()
    }
  })

  test.each(TIERS)('%s:打包配置真的把它接上了,且 asar 仍关着(asar 类 fuse 因此不能开)', (tier) => {
    const config = loadBuilderConfig(tier)
    expect(config.electronFuses).toEqual(resolveElectronFuses({ tier }))
    expect(config.asar).toBe(false)
  })
})

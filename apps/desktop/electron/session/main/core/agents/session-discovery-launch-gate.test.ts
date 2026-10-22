import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 「这一家能不能起」只有一个判据:session_list_harnesses 与 session_spawn 问的都是启动那道闸
// (`assertLocalHarnessLaunchable`)。这里用真的插件声明、真的版本闸、真的 `--version` 子进程;
// 只把「解析出哪个可执行文件」换成夹具里的假引擎 —— 它打印什么版本,由每一格自己写。

const engines: Record<string, { cli: string; runtimeExecutable?: string }> = {}
vi.mock('./agent-run-context', () => ({
  resolveLocalAgentRunContext: async (providerId: string) => {
    const engine = engines[providerId]
    return {
      cli: engine ? { kind: 'resolved', path: engine.cli } : { kind: 'unresolved', message: `${providerId} is not installed` },
      env: {},
      configRootEnv: {},
      ...(engine?.runtimeExecutable ? { runtimeExecutable: engine.runtimeExecutable } : {}),
    }
  },
}))

const { assertLocalHarnessLaunchable, listHarnessesFrom } = await import('./session-discovery')
const { getPlugin } = await import('./plugin-registry')

const dir = mkdtempSync(join(tmpdir(), 'launch-gate-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 一份打印 `printed` 的假引擎;同一路径再写一次 = 就地升级。 */
function engine(name: string, printed: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\necho "${printed}"\n`)
  chmodSync(path, 0o755)
  return path
}

beforeEach(() => {
  for (const id of Object.keys(engines)) delete engines[id]
})

function listOf(ids: string[]) {
  return listHarnessesFrom({
    listOffered: () => ids.map((id) => getPlugin(id)),
    get: (id) => getPlugin(id),
    manager: {
      get: (id) => ({ id, category: 'agent', status: 'available', version: null, path: null, checkedAt: 0 }),
      getAll: () => new Map(),
      getHostDependency: () => undefined,
    },
    ensureProbed: async () => {},
    assertLaunchable: assertLocalHarnessLaunchable,
    getModelCatalog: async () => ({ kind: 'unsupported' }) as never,
    getPlatformCatalog: async () => null,
  })
}

describe('启动那道闸 = 列表与 spawn 的唯一判据', () => {
  it('acp 腿(hermes 0.21.0 < 0.21.5):列表 spawnable:false,原话就是启动时那句;就地升级后不重启再列就是 true', async () => {
    engines.hermes = { cli: engine('hermes', 'Hermes Agent v0.21.0') }
    await expect(assertLocalHarnessLaunchable('hermes', 'acp'))
      .rejects.toThrow(/hermes acp requires harness runtime 0\.21\.5 or newer; found 0\.21\.0/)
    const [before] = await listOf(['hermes'])
    expect(before.spawnable).toBe(false)
    expect(before.blocked?.acp).toMatch(/requires harness runtime 0\.21\.5 or newer; found 0\.21\.0/)

    engine('hermes', 'Hermes Agent v0.21.5')
    const [after] = await listOf(['hermes'])
    expect(after.blocked).toBeUndefined()
    expect(after.spawnable).toBe(true)
    await expect(assertLocalHarnessLaunchable('hermes', 'acp')).resolves.toBeUndefined()
  })

  it('判定兼容的读数在多次列表之间共用;同一路径换了文件(mtime/size 变了)就重探', async () => {
    const count = join(dir, 'opencode.count')
    const path = join(dir, 'opencode')
    const write = (version: string) => {
      writeFileSync(path, `#!/bin/sh\necho x >> "${count}"\necho "${version}"\n`)
      chmodSync(path, 0o755)
    }
    const probes = () => readFileSync(count, 'utf8').split('\n').filter(Boolean).length
    write('1.18.25')
    engines.opencode = { cli: path }
    await listOf(['opencode'])
    const afterFirst = probes()
    await listOf(['opencode'])
    expect(probes()).toBe(afterFirst)

    write('1.17.0-downgraded')
    const [row] = await listOf(['opencode'])
    expect(probes()).toBeGreaterThan(afterFirst)
    expect(row.blocked?.acp).toMatch(/requires harness runtime 1\.18\.0 or newer; found 1\.17\.0-downgraded/)
  })

  it('tui 腿(claude 2.1.0 < 2.1.69):只挡终端腿,聊天腿照样能起', async () => {
    engines.claude = { cli: engine('claude', '2.1.0 (Claude Code)') }
    const [row] = await listOf(['claude'])
    expect(row.blocked?.pty).toMatch(/claude tui requires harness runtime 2\.1\.69 or newer; found 2\.1\.0/)
    expect(row.blocked?.acp).toBeUndefined()
    expect(row.spawnable).toBe(true)
  })

  it('codex 终端腿也过 app-server 那一格下界(起 app-server 前那道闸)', async () => {
    engines.codex = { cli: engine('codex', 'codex-cli 0.1.0') }
    await expect(assertLocalHarnessLaunchable('codex', 'pty')).rejects.toThrow(/codex app-server requires harness runtime/)
  })

  it('经 node 起的家(pi):Pi 版本通过后仍独立检查 node 的范围', async () => {
    const entry = join(dir, 'pi.js')
    writeFileSync(entry, `#!${process.execPath}\nconsole.log('1.3.0')\n`)
    chmodSync(entry, 0o755)
    engines.pi = { cli: entry, runtimeExecutable: engine('node-23.7', 'v23.7.0') }
    await expect(assertLocalHarnessLaunchable('pi', 'pty')).rejects.toThrow(/requires Node runtime one of >=22\.15\.0 <23\.0\.0, >=23\.8\.0; found 23\.7\.0/)
    engines.pi = { cli: entry, runtimeExecutable: engine('node-22.16', 'v22.16.0') }
    await expect(assertLocalHarnessLaunchable('pi', 'pty')).resolves.toBeUndefined()
  })

  it('没声明下界的家不探版本:可执行文件打印什么都不影响', async () => {
    const plugin = getPlugin('gemini')
    expect(plugin.capabilities.sessionBundle.runtimeCompatibility).toBeUndefined()
    engines.gemini = { cli: engine('gemini', 'not a version') }
    await expect(assertLocalHarnessLaunchable('gemini', 'acp')).resolves.toBeUndefined()
  })

  it('解析不出可执行文件:同样当场报解析器的原话', async () => {
    await expect(assertLocalHarnessLaunchable('hermes', 'acp')).rejects.toThrow(/hermes is not installed/)
  })
})

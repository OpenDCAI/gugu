import { mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #7081:Claude Code 就地升级后,模型目录要在**下一次读**时换成新版本报的清单,❌ 等 12h TTL / 重启咕咕。
 *
 * 身份解析器是生产那一个(`resolveHarnessSpawnIdentity`),目录缓存是生产那一份;
 * 桩掉的只有「这家解析到哪条路径」(本机的依赖选择)与组合根里和本题无关的 db / 插件表。
 * 升级动作全是真的:真目录、真软链接改指向、真原地覆盖。
 */
const spawnContext = vi.hoisted(() => ({ cli: '' }))
vi.mock('@main/db/client', () => ({ db: {} }))
vi.mock('../../../../apps/desktop/electron/session/main/core/agents/plugin-registry', () => ({
  getPlugin: () => ({ capabilities: { sessionBundle: {} } }),
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/acp/transport/local-acp-process-host', () => ({
  resolveLocalAcpSpawnContext: async () => ({
    cli: spawnContext.cli,
    agentEnv: { CLAUDE_CONFIG_DIR: '/home/someone/.claude' },
    runContext: {},
  }),
}))

const {
  __drainProbesForTest,
  __resetHarnessModelCatalogCache,
  getHarnessModelCatalog,
  lookupHarnessModelCatalog,
  setAcpSpawnResolver,
  setCatalogStore,
  setProbePlatformEnvResolver,
  setSpawnIdentityResolver,
} = await import('../../../../apps/desktop/electron/session/main/core/agents/harness-model-catalog')
const { resolveHarnessSpawnIdentity } = await import(
  '../../../../apps/desktop/electron/session/main/core/agents/harness-model-catalog-wiring'
)

/**
 * 一个会说 ACP 的假桥:像真桥起 `CLAUDE_CODE_EXECUTABLE` 那样,读 argv[2] 那条路径上的「claude」,
 * 把它报的 Haiku 名字放进清单 —— 于是清单**真的**随那条路径此刻指着的文件变。
 */
const BRIDGE = `
import fs from 'node:fs';
const haiku = fs.readFileSync(process.argv[2], 'utf8').trim();
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });
    if (msg.method === 'session/new') reply({
      sessionId: 's',
      configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'default', options: [
        { value: 'default', name: 'Default' },
        { value: 'haiku', name: haiku },
      ] }],
    });
  }
});
`

let dir: string
let link: string
let probes = 0

function haikuOf(state: { kind: string; models?: Array<{ id: string; name: string }> }): string | undefined {
  return state.models?.find((m) => m.id === 'haiku')?.name
}

/** 原生安装器的升级:新版本落进 versions/,`bin/claude` 改指它。路径不变。 */
async function pointLinkAt(target: string): Promise<void> {
  await unlink(link).catch(() => undefined)
  await symlink(target, link)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gugu-7081-'))
  link = join(dir, 'claude')
  const bridge = join(dir, 'bridge.mjs')
  await writeFile(bridge, BRIDGE, 'utf8')
  probes = 0
  __resetHarnessModelCatalogCache()
  setCatalogStore(null)
  setProbePlatformEnvResolver(async () => ({ env: {} }))
  setSpawnIdentityResolver(resolveHarnessSpawnIdentity)
  setAcpSpawnResolver(async () => {
    probes += 1
    return { command: process.execPath, args: [bridge, spawnContext.cli], env: {} }
  })
  spawnContext.cli = link
})

afterEach(async () => {
  await __drainProbesForTest()
  setSpawnIdentityResolver(async () => null)
  setAcpSpawnResolver(async () => null)
  await rm(dir, { recursive: true, force: true })
})

// 软链接在 Windows 上要开发者模式 / 管理员;原地覆盖那条三平台都跑。
describe.skipIf(process.platform === 'win32')('#7081 原生安装器改软链接指向', () => {
  it('下一次读目录就是新版本报的清单 —— 版本号还是启动时探的那份也一样', async () => {
    const v280 = join(dir, '2.1.280')
    const v296 = join(dir, '2.1.296')
    await writeFile(v280, 'Haiku 4.5')
    await writeFile(v296, 'Haiku 5.5')
    await pointLinkAt(v280)

    // 依赖管理器只在启动时探一次版本 ⇒ 升级之后递进来的仍是 2.1.280。
    const harnessVersion = '2.1.280'
    expect(haikuOf(await getHarnessModelCatalog('claude', { leg: 'acp', harnessVersion }))).toBe('Haiku 4.5')
    // 阴控:什么都没动 ⇒ 吃缓存。指纹不能把缓存变成摆设。
    await getHarnessModelCatalog('claude', { leg: 'acp', harnessVersion })
    expect(probes).toBe(1)

    await pointLinkAt(v296)

    expect(haikuOf(await getHarnessModelCatalog('claude', { leg: 'acp', harnessVersion }))).toBe('Haiku 5.5')
    expect(probes).toBe(2)
  })

  /** 渲染层走的是这条(`agents.modelCatalog` → lookup):先给陈的 + refreshing,轮询收敛到新清单。 */
  it('lookup:升级后答「陈的 + 还在探」,收摊后答新清单', async () => {
    const v280 = join(dir, '2.1.280')
    const v296 = join(dir, '2.1.296')
    await writeFile(v280, 'Haiku 4.5')
    await writeFile(v296, 'Haiku 5.5')
    await pointLinkAt(v280)
    const ask = () => lookupHarnessModelCatalog('claude', { leg: 'acp', harnessVersion: '2.1.280' })

    await ask()
    await __drainProbesForTest()
    const settled = await ask()
    expect(settled.refreshing).toBe(false)
    expect(haikuOf(settled.state)).toBe('Haiku 4.5')

    await pointLinkAt(v296)

    const stale = await ask()
    expect(stale.refreshing).toBe(true)
    expect(haikuOf(stale.state)).toBe('Haiku 4.5')
    await __drainProbesForTest()
    const fresh = await ask()
    expect(fresh.refreshing).toBe(false)
    expect(haikuOf(fresh.state)).toBe('Haiku 5.5')
  })
})

describe('#7081 npm / brew 原地覆盖', () => {
  it('同一条路径上的文件被覆盖 → 下一次读目录就是新清单', async () => {
    const cli = join(dir, 'cli.js')
    await writeFile(cli, 'Haiku 4.5')
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000)
    await utimes(cli, yesterday, yesterday)
    spawnContext.cli = cli
    const harnessVersion = '2.1.280'

    expect(haikuOf(await getHarnessModelCatalog('claude', { leg: 'acp', harnessVersion }))).toBe('Haiku 4.5')
    await getHarnessModelCatalog('claude', { leg: 'acp', harnessVersion })
    expect(probes).toBe(1)

    await writeFile(cli, 'Haiku 5.5')

    expect(haikuOf(await getHarnessModelCatalog('claude', { leg: 'acp', harnessVersion }))).toBe('Haiku 5.5')
    expect(probes).toBe(2)
  })
})

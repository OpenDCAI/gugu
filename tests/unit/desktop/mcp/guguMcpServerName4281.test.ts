// #4281 —— MCP server 的**声明名**分布在两个包里,而两侧不一致时没有任何一层会在开发期报错:
//   · 宿主侧(apps/desktop/electron)注册 + 交给 harness 的 `AcpMcpServer.name`,以及 codex 的配置键;
//   · 版本化静态插件包(packages/session-plugins)的 `.mcp.json` 里的 server 键。
// 宿主侧已经收敛成单一出处(mcp/gugu-mcp-name.mjs);跨包那一侧刻意保持独立声明(它是审计字节),
// 运行期由 `assertPackageDeclaresMcpServers()` fail loud —— 但那要等到真起一条会话。这条测试把
// 「两侧对不上」提前到单测就红。
//
// ⚠️ 别把这条写成「两个常量互相 import 后比自己」——那是恒真。一侧读**产物字节**(插件包真正写出的
// `.mcp.json`),另一侧读宿主常量,才是两份独立事实的对账。
import { pluginRegistry } from '@gugu/session-plugins/agents'
import type { SessionCapabilityBundle } from '@gugu/session-core/agents/plugins'
import { describe, expect, it } from 'vitest'
import { GUGU_MCP_CONFIG_KEY, GUGU_MCP_SERVER_NAME } from '../../../../apps/desktop/electron/mcp/gugu-mcp-name.mjs'
import { PRODUCT_CAPABILITY_PACKAGES } from '../../../../apps/desktop/electron/capability-bundle'

/**
 * 产品真正发出去的那几份 `.mcp.json` 字节 —— **两种产地**都要收进来:
 *
 * · 静态能力包里随包发出去的(codex 那一份);
 * · 物化时**按会话现生成**的(claude 那一份)。它 2026-09-15 从静态包搬出来了:一条会话该挂哪几台
 *   server 取决于用户连了哪些集成,那在打包时不可能知道。
 *
 * ⚠️ 只扫静态包会让 claude 这一侧**悄悄退出这张考卷** —— 名字对不上照样全绿,正是本文件要防的事。
 */
function packagesDeclaringMcp(): Array<{ id: string; mcp: string }> {
  const fromPackages = PRODUCT_CAPABILITY_PACKAGES.flatMap((pkg) => {
    const mcp = pkg.artifacts.find((artifact) => artifact.path === '.mcp.json')
    return mcp ? [{ id: pkg.id, mcp: mcp.content }] : []
  })
  return [...fromPackages, ...generatedMcpConfigs()]
}

/** 只放咕咕自己那台的最小会话包 —— 这张考卷问的是**名字**,不是投递面。 */
function guguOnlyBundle(): SessionCapabilityBundle {
  const authEnv = `GUGU_SESSION_MCP_AUTH_${GUGU_MCP_SERVER_NAME.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`
  return {
    mcpServers: [{
      name: GUGU_MCP_SERVER_NAME,
      url: 'http://127.0.0.1:44100/mcp/probe',
      authorizationEnv: authEnv,
      alwaysLoad: true,
      owner: 'gugu',
    }],
    mcpDisabled: undefined,
    env: { GUGU_HOME: '/tmp/gugu-4281', HOME: '/tmp/gugu-4281-user', [authEnv]: 'Bearer probe' },
    model: null,
    autonomy: null,
    promptBlocks: {},
    packages: PRODUCT_CAPABILITY_PACKAGES,
  }
}

/** 物化时现生成的那几份 `.mcp.json`(今天只有 claude,判据按「谁生成谁进考卷」写,不点名)。 */
function generatedMcpConfigs(): Array<{ id: string; mcp: string }> {
  const bundle = guguOnlyBundle()
  const found: Array<{ id: string; mcp: string }> = []
  for (const provider of pluginRegistry.getAll()) {
    const behavior = provider.behavior.sessionBundle
    const descriptor = provider.capabilities.sessionBundle
    if (!behavior || !descriptor) continue
    for (const surface of descriptor.surfaces) {
      let artifacts
      try {
        artifacts = behavior.materialize(
          { surface, lifecycle: 'fresh', cwd: '/tmp/gugu-4281-ws' },
          bundle,
        ).artifacts
      } catch { continue }
      const mcp = artifacts.find((artifact) => artifact.path.endsWith('.mcp.json'))
      if (mcp) found.push({ id: `${provider.metadata.id}/${surface} (generated)`, mcp: mcp.content })
    }
  }
  return found
}

function declaredServerKeys(mcp: string): string[] {
  const parsed = JSON.parse(mcp) as { mcpServers?: Record<string, unknown> }
  return Object.keys(parsed.mcpServers ?? {}).sort()
}

describe('#4281 · the gugu MCP server name has one value on every side', () => {
  it('每个带 .mcp.json 的能力包恰好声明宿主注册的那一台 server', () => {
    const declaring = packagesDeclaringMcp()
    // 阳性对照:确实扫到了包 —— 否则下面的 for 在空集上恒真。
    expect(declaring.map(({ id }) => id).sort(), 'positive control: every .mcp.json the product emits')
      .toEqual([
        'claude/acp (generated)',
        'claude/tui (generated)',
        'gugu-product-codex',
      ])
    for (const { id, mcp } of declaring) {
      expect(declaredServerKeys(mcp), `${id} declares exactly the host-registered server`)
        .toEqual([GUGU_MCP_SERVER_NAME])
    }
  })

  it('codex 的 server 配置键 = 声明名经 codex 归一,不是第二个字面量', () => {
    // 归一规则本身:非 [A-Za-z0-9_] → `_`。用**合成**样本判,❌ 不拿产品名当样本 —— `gugu` 里没有
    // 需要归一的字符,拿它当样本时 replace 是 no-op,断言会退化成一句恒真的话。
    const sanitize = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_')
    expect(sanitize('gugu-im'), 'positive control: the rule really rewrites a hyphen').toBe('gugu_im')
    expect(GUGU_MCP_CONFIG_KEY).toBe(sanitize(GUGU_MCP_SERVER_NAME))
  })

  it('派生的 spawn 环境变量名跟着声明名走', () => {
    const suffix = GUGU_MCP_SERVER_NAME.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
    for (const { id, mcp } of packagesDeclaringMcp()) {
      expect(mcp, `${id} references the URL env derived from the server name`)
        .toContain(`GUGU_SESSION_MCP_URL_${suffix}`)
      // claude 用 Authorization header,codex 用 bearer_token_env_var —— 两种形态,同一个后缀。
      expect(
        mcp.includes(`GUGU_SESSION_MCP_AUTH_${suffix}`) || mcp.includes(`GUGU_SESSION_MCP_BEARER_${suffix}`),
        `${id} references the auth env derived from the server name`,
      ).toBe(true)
    }
  })
})

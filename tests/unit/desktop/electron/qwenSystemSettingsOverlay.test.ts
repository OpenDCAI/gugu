import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { materializeQwenSessionBundle } from '@gugu/session-plugins/agents'
import { applySessionMaterialization } from '../../../../apps/desktop/electron/session-materialization'

// #4834:qwen 终端腿的 MCP 从「合并进用户 ~/.qwen/settings.json」改成「run-scoped 的系统级
// settings 副本 + QWEN_CODE_SYSTEM_SETTINGS_PATH」。这一组量的是**落盘之后磁盘上的事实**,
// ❌ 不看物化器自报。
//
// ⚠️ 这条通道的成立前提是 qwen 的 settings 加载器会展开 `${VAR}`(实测见该家 descriptor 的
//    units.mcp)。所以最要紧的一条判据是:**令牌真值不在磁盘上**。

const AUTH_ENV = 'GUGU_SESSION_MCP_AUTH_GUGU'
const AUTH_VALUE = 'Bearer live-capability-grant'

function bundle(guguHome: string, systemSettingsPath: string, alwaysLoad = false) {
  return {
    mcpServers: [{
      name: 'gugu' as const,
      url: 'http://127.0.0.1:44100/mcp',
      authorizationEnv: AUTH_ENV,
      // 真实会话包里这台恒是 alwaysLoad + owner 'gugu'(acp-engine-utils);阴控才去掉这两格。
      ...(alwaysLoad ? { alwaysLoad: true, owner: 'gugu' as const } : {}),
    }],
    env: {
      GUGU_HOME: guguHome,
      [AUTH_ENV]: AUTH_VALUE,
      QWEN_CODE_SYSTEM_SETTINGS_PATH: systemSettingsPath,
    },
    model: null,
    autonomy: null,
    promptBlocks: {},
    packages: [],
  }
}

async function materializeAndApply(
  root: string,
  systemSettingsPath: string,
  surface: 'tui' | 'acp' = 'tui',
  alwaysLoad = false,
) {
  const guguHome = join(root, 'gugu')
  const materialization = materializeQwenSessionBundle(
    { surface, lifecycle: 'fresh', cwd: join(root, 'worktree') },
    bundle(guguHome, systemSettingsPath, alwaysLoad)
  )
  await applySessionMaterialization({
    cwd: join(root, 'worktree'),
    guguHome,
    materialization,
  })
  return materialization
}

describe('qwen 终端腿:系统级 settings 的 run-scoped 副本 (#4834)', () => {
  it('合并管理员那份配置、原文件一个字节不变、令牌不落盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-qwen-overlay-'))
    try {
      const systemSettings = join(root, 'etc-qwen-settings.json')
      const adminBytes = JSON.stringify(
        {
          // 管理员的策略键 —— 走这条通道时必须原样带进副本,否则等于在这次会话里静默吞掉它。
          security: { auth: { selectedType: 'openai' } },
          mcpServers: { 'admin-owned': { command: 'admin-server', args: ['--keep'] } },
        },
        null,
        2
      )
      await writeFile(systemSettings, adminBytes, { mode: 0o600 })

      const materialization = await materializeAndApply(root, systemSettings)
      const overlayPath = materialization.jsonOverlays![0].path
      const written = JSON.parse(await readFile(overlayPath, 'utf8')) as Record<string, unknown>

      // 管理员的两样都在
      expect(written.security).toEqual({ auth: { selectedType: 'openai' } })
      expect((written.mcpServers as Record<string, unknown>)['admin-owned']).toEqual({
        command: 'admin-server',
        args: ['--keep'],
      })
      // 咕咕这一条也在,且 Authorization 是**占位符**
      expect((written.mcpServers as Record<string, unknown>).gugu).toEqual({
        httpUrl: 'http://127.0.0.1:44100/mcp',
        headers: {
          Authorization: `\${${AUTH_ENV}}`,
          Accept: 'application/json, text/event-stream',
        },
      })

      // ⚠️ 本次改动的红线:令牌真值一个字节都不在磁盘上。
      const raw = await readFile(overlayPath, 'utf8')
      expect(raw).not.toContain(AUTH_VALUE)
      expect(materialization.env[AUTH_ENV]).toBe(AUTH_VALUE)

      // 副本是 0600,且落在咕咕自己的地盘
      expect((await stat(overlayPath)).mode & 0o777).toBe(0o600)
      expect(overlayPath.startsWith(join(root, 'gugu'))).toBe(true)

      // 原文件逐字节不变 —— source-backed 的全部意义
      expect(await readFile(systemSettings, 'utf8')).toBe(adminBytes)

      // 引擎被指向副本;system-defaults 显式钉回原目录(qwen 从 settings 路径的目录推它)
      expect(materialization.env.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBe(overlayPath)
      expect(materialization.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH).toBe(
        join(root, 'system-defaults.json')
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('管理员那份根本不存在时,照样只写咕咕这一条', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-qwen-overlay-none-'))
    try {
      const missing = join(root, 'no-such-system-settings.json')
      const materialization = await materializeAndApply(root, missing)
      const written = JSON.parse(
        await readFile(materialization.jsonOverlays![0].path, 'utf8')
      ) as { mcpServers: Record<string, unknown> }
      expect(Object.keys(written.mcpServers)).toEqual(['gugu'])
      // ❌ 不因为读不到就顺手把文件造出来
      expect(await readdir(root)).not.toContain('no-such-system-settings.json')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('#6195:hooks 住在副本里 —— 没配 MCP、没选平台模型也照样生成;管理员的 JSONC 文件与同名事件 hooks 与咕咕的并存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-qwen-overlay-hooks-'))
    try {
      const systemSettings = join(root, 'etc-qwen-settings.json')
      const adminHook = { hooks: [{ type: 'command', command: 'admin-audit' }] }
      // JSONC(注释 + 尾逗号)是 qwen 认的合法语法;同名事件 Stop 上管理员已经挂了 hook。
      await writeFile(
        systemSettings,
        `{\n  // admin policy\n  "hooks": { "PreToolUse": [${JSON.stringify(adminHook)}], "Stop": [${JSON.stringify(adminHook)}], },\n}\n`,
        { mode: 0o600 }
      )
      const guguHome = join(root, 'gugu')
      const materialization = materializeQwenSessionBundle(
        { surface: 'tui', lifecycle: 'fresh', cwd: join(root, 'worktree') },
        { ...bundle(guguHome, systemSettings), mcpServers: [], env: { GUGU_HOME: guguHome, QWEN_CODE_SYSTEM_SETTINGS_PATH: systemSettings } }
      )
      await applySessionMaterialization({ cwd: join(root, 'worktree'), guguHome, materialization })
      const overlayPath = materialization.jsonOverlays![0].path
      expect(overlayPath.startsWith(guguHome)).toBe(true)
      expect(materialization.env.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBe(overlayPath)
      const written = JSON.parse(await readFile(overlayPath, 'utf8')) as { hooks: Record<string, unknown[]> }
      expect(written.hooks.PreToolUse).toEqual([adminHook])
      // 同名事件:管理员的在前、咕咕的在后,两个都在
      expect(written.hooks.Stop[0]).toEqual(adminHook)
      expect(JSON.stringify(written.hooks.Stop[1])).toContain('GUGU_HOOK_PORT')
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd']) {
        expect(JSON.stringify(written.hooks[event]), event).toContain('GUGU_HOOK_PORT')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('反例对照:管理员已经有一条同名 server 时,fail loud ❌ 不静默改写他的意图', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-qwen-overlay-clash-'))
    try {
      const systemSettings = join(root, 'etc-qwen-settings.json')
      await writeFile(
        systemSettings,
        JSON.stringify({ mcpServers: { gugu: { command: 'admins-own-gugu' } } }),
        { mode: 0o600 }
      )
      await expect(materializeAndApply(root, systemSettings)).rejects.toThrow(
        'JSON merge conflict at mcpServers.gugu'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // #6192:qwen 0.24.x 把 MCP 工具延迟装载(只能 tool_search + tool_call 桥够到)。会话包的
  // `alwaysLoad` 只有 settings 条目上的 `alwaysLoadTools` 送得到 —— ACP 协议的 McpServer 没这个字段,
  // 所以 ACP 腿也走这份副本,`session/new` 一台都不递(递了会按名盖掉副本里那台,开关随之丢失)。
  it.each(['acp', 'tui'] as const)(
    '%s:alwaysLoad 落成 alwaysLoadTools,ACP 腿不经 session/new 递 server',
    async (surface) => {
      const root = await mkdtemp(join(tmpdir(), `gugu-qwen-overlay-${surface}-`))
      try {
        const materialization = await materializeAndApply(
          root, join(root, 'no-such-system-settings.json'), surface, true,
        )
        const raw = await readFile(materialization.jsonOverlays![0].path, 'utf8')
        const written = JSON.parse(raw) as { mcpServers: Record<string, Record<string, unknown>> }
        expect(written.mcpServers.gugu.alwaysLoadTools).toBe(true)
        // 咕咕自有 server 的产品工具不进审批:qwen 的原生开关是 trust
        expect(written.mcpServers.gugu.trust).toBe(true)
        expect(materialization.acp).toBeUndefined()
        expect(raw).not.toContain(AUTH_VALUE)
        expect(materialization.env[AUTH_ENV]).toBe(AUTH_VALUE)
        expect(materialization.report.units.mcp).toEqual({ status: 'loaded' })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('阴控:没声明 alwaysLoad / owner 的 server 不带 alwaysLoadTools 与 trust(开关只来自会话包,不是一律打开)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-qwen-overlay-lazy-'))
    try {
      const materialization = await materializeAndApply(
        root, join(root, 'no-such-system-settings.json'), 'acp', false,
      )
      const written = JSON.parse(
        await readFile(materialization.jsonOverlays![0].path, 'utf8')
      ) as { mcpServers: Record<string, Record<string, unknown>> }
      expect(written.mcpServers.gugu).not.toHaveProperty('alwaysLoadTools')
      expect(written.mcpServers.gugu).not.toHaveProperty('trust')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

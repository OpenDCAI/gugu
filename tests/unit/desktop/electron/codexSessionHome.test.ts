import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEX_GUGU_CAPABILITY_PACKAGE,
  materializeCodexSessionBundle,
} from '@gugu/session-plugins/agents'
import { applySessionMaterialization } from '../../../../apps/desktop/electron/session-materialization'

// 这组判据钉的是 owner 2026-08-14 报的那个 bug 的根因:咕咕曾给每个会话**合成**一个 CODEX_HOME。
// codex 的 hook 信任键里带的是「声明该 hook 的 config.toml 的绝对路径」,home 每次都换 → 用户点过的
// 信任永远对不上,授权每个会话重弹。当时为了让合成 home 还能用,又补了一串软链把真 home 的
// auth.json / sessions / plugins 接回去 —— 一整套绷带,包扎的是自己造的伤口。
//
// 现在 home 就是用户自己的那个。判据因此从「隔离 home 铺得对不对」翻成「**一个字节都别碰**」。
async function tree(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      out.push(entry.isDirectory() ? `${rel}/` : rel)
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel)
    }
  }
  await walk(root, '')
  return out.sort()
}

function codexBundle(guguHome: string, userHome: string) {
  return {
    mcpServers: [{
      name: 'gugu' as const,
      url: 'http://127.0.0.1:44100/mcp',
      authorizationEnv: 'SOURCE_BEARER',
    }],
    env: {
      GUGU_HOME: guguHome,
      CODEX_HOME: userHome,
      SOURCE_BEARER: 'Bearer capability',
    },
    model: null,
    autonomy: null,
    promptBlocks: {},
    packages: [CODEX_GUGU_CAPABILITY_PACKAGE],
  }
}

describe('Codex 会话不再动用户的 home', () => {
  it('物化并落盘后,用户的 $CODEX_HOME 一个字节都没变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-codex-home-'))
    try {
      const guguHome = join(root, 'gugu')
      const userHome = join(root, 'user-codex')
      const userConfig = 'model = "user-model"\n[features]\nexample = true\n'
      const userAuth = '{"live":"auth-source"}\n'
      await mkdir(join(userHome, 'plugins', 'cache', 'native-marketplace'), { recursive: true })
      await mkdir(join(userHome, 'sessions', '2026', '07', '30'), { recursive: true })
      await writeFile(join(userHome, 'config.toml'), userConfig, { mode: 0o600 })
      await writeFile(join(userHome, 'auth.json'), userAuth, { mode: 0o600 })
      const before = await tree(userHome)

      const materialization = materializeCodexSessionBundle(
        { surface: 'app-server', lifecycle: 'fresh', cwd: join(root, 'workspace') },
        codexBundle(guguHome, userHome),
      )
      expect(materialization.env.CODEX_HOME).toBe(userHome)

      await applySessionMaterialization({
        cwd: join(root, 'workspace'),
        guguHome,
        materialization,
      })

      expect(await readFile(join(userHome, 'config.toml'), 'utf8')).toBe(userConfig)
      expect(await readFile(join(userHome, 'auth.json'), 'utf8')).toBe(userAuth)
      // 结构也不许多一个文件:软链、插件缓存、市场登记,一样都不该冒出来。
      expect(await tree(userHome)).toEqual(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('不再在 GUGU_HOME 下造任何 run-scoped codex home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-codex-home-none-'))
    try {
      const guguHome = join(root, 'gugu')
      const userHome = join(root, 'user-codex')
      await mkdir(userHome, { recursive: true })
      await mkdir(guguHome, { recursive: true })
      await writeFile(join(userHome, 'config.toml'), 'model = "user-model"\n', { mode: 0o600 })

      const materialization = materializeCodexSessionBundle(
        { surface: 'app-server', lifecycle: 'fresh', cwd: join(root, 'workspace') },
        codexBundle(guguHome, userHome),
      )
      await applySessionMaterialization({
        cwd: join(root, 'workspace'),
        guguHome,
        materialization,
      })

      expect(await tree(guguHome)).toContain('agent-homes/codex/.codex/config.toml')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // 从前隔离 home 里没有 sessions/,codex 按 `$CODEX_HOME/sessions` 找 rollout 一律
  // `no rollout found for thread id …` —— 用户已有的 codex 会话导入后打不开。当时靠软链绷带兜住;
  // home 归还给用户之后,这条路自然就通了,判据钉「resume 不再需要任何绷带」。
  it('resume 时用户已有的 rollout 天然在 $CODEX_HOME/sessions 下,不需要任何软链', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-codex-home-resume-'))
    try {
      const guguHome = join(root, 'gugu')
      const userHome = join(root, 'user-codex')
      const rolloutDir = join(userHome, 'sessions', '2026', '07', '30')
      await mkdir(rolloutDir, { recursive: true })
      await writeFile(
        join(rolloutDir, 'rollout-2026-07-30T21-11-44-thread-under-test.jsonl'),
        '{"id":"thread-under-test"}\n',
      )

      const materialization = materializeCodexSessionBundle(
        { surface: 'app-server', lifecycle: 'resume', cwd: join(root, 'workspace') },
        codexBundle(guguHome, userHome),
      )
      expect(materialization.env.CODEX_HOME).toBe(userHome)
      expect(materialization.symlinks ?? []).toEqual([])
      expect(materialization.directorySymlinkOverlays ?? []).toEqual([])
      expect(materialization.tomlOverlays).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

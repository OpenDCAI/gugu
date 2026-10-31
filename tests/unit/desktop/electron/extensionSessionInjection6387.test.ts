// #6387 owner 2026-09-24 选 B:扩展开发时写清它带哪些 MCP 程序和 skill,装上之后每条新会话都注入。
// 这里判三件事:声明怎么变成咕咕要起的程序(#6615 起经扩展网关交给会话);skill 在能挂插件目录的家(claude)原生挂进去;
// 挂不了的家从平台说明里拿到同一份目录 —— 两条路互斥,同一个 agent 不会看到两遍。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_GUGU_CAPABILITY_PACKAGE, materializeCodexSessionBundle, pluginRegistry } from '@gugu/session-plugins/agents'
import { mountsExtensionSkillsNatively, type SessionCapabilityBundle } from '@gugu/session-core/agents/plugins'
import { describe, expect, it, vi } from 'vitest'
import { agentAppsOf, extensionAgentPrograms, readExtensionSkills } from '../../../../apps/desktop/electron/extension-session-mcp'
import { GUGU_APPS_LINES_TOKEN_BUDGET, GUGU_APPS_SEARCH_LINE, PRODUCT_CAPABILITY_PACKAGES, guguAppsBlock, sessionExtensionDelivery, loadCodexAppServerCapabilities, loadClaudeTuiCapabilities, loadSessionTuiCapabilities } from '../../../../apps/desktop/electron/capability-bundle'
import { estimatePromptTokens } from '../../../../apps/desktop/electron/product-platform-prompt'
import { EXTENSION_API_VERSION, safeParseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { GUGU_MCP_SERVER_NAME } from '../../../../apps/desktop/electron/mcp/gugu-mcp-name.mjs'

function extensionFolder(skills: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gugu-6387-ext-'))
  for (const [folder, skillMd] of Object.entries(skills)) {
    mkdirSync(join(root, 'skills', folder), { recursive: true })
    writeFileSync(join(root, 'skills', folder, 'SKILL.md'), skillMd)
  }
  return root
}

const NOTES_SKILL = '---\nname: agent-notes\ndescription: Save and search notes the person keeps in 随手记\n---\n# body\n'
/** A good skill's read says nothing: a problem here is the test's fixture failing, loudly. */
const noProblem = (message: string) => { throw new Error(`unexpected skill problem: ${message}`) }

// skill 注入核查 10-14 坏签探针: an unquoted「: 」in a description is not YAML, its sibling is.
const BAD_STAMP = '---\nname: bad-stamp\ndescription: Use when someone asks for a red stamp (红签): run its script.\n---\n# body\n'
const OK_STAMP = '---\nname: ok-stamp\ndescription: "Use when someone asks for a green stamp (绿签): run its script."\n---\n# body\n'

describe('extension MCP programs become the programs gugu runs (#6387, #6615)', () => {
  it('passes saved user configuration to the program and overrides a bundle-supplied settings environment', () => {
    const rootDir = extensionFolder({});
    const settings = { account: 'work', confirmation: false };
    const { programs } = extensionAgentPrograms([{
      extensionId: 'configurable', name: 'Configurable', rootDir, dataDir: '/data/configurable', digest: 'settings-1',
      settings, disclosure: 'progressive', skillsDir: null,
      servers: [{ name: 'configurable', command: 'node', args: ['server.mjs'], env: { GUGU_APP_SETTINGS: 'bundle-value' } }],
    }], { nodeExecutable: process.execPath, toolsRuntime: null, linkPrefix: 'gugu-dev://ext', onProblem: vi.fn() });
    expect(JSON.parse(programs[0]!.env.GUGU_APP_SETTINGS!)).toEqual(settings);
  });
  const host = {
    nodeExecutable: '/Applications/咕咕.app/Contents/MacOS/咕咕',
    toolsRuntime: '/Applications/咕咕.app/Contents/Resources/app-runtime/gugu-tools.mjs',
    linkPrefix: 'gugu-dev://ext',
    onProblem: vi.fn(),
  }

  it('摩擦单 F77 a tools module runs on gugu’s own runtime, which serves it as MCP; a missing module is left out, loudly', () => {
    const rootDir = extensionFolder({})
    writeFileSync(join(rootDir, 'tools.js'), 'export const follow = {}')
    const onProblem = vi.fn()
    const app = (extensionId: string, tools: string) => ({
      extensionId, name: extensionId, rootDir, dataDir: `/data/${extensionId}`, digest: 'd1', disclosure: 'progressive' as const, servers: [{ tools }], skillsDir: null,
    })
    const { programs } = extensionAgentPrograms([app('board', 'tools.js'), app('gone', 'lib/gone.js')], { ...host, onProblem })

    // F119: a tools module is named after its App.
    expect(programs.map(({ server, command, args, onGuguNode }) => ({ server, command, args, onGuguNode }))).toEqual([
      { server: 'board', command: host.nodeExecutable, args: [host.toolsRuntime, join(rootDir, 'tools.js')], onGuguNode: true },
    ])
    expect(programs[0]!.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(onProblem).toHaveBeenCalledWith('extension gone: program gone left out of the session: lib/gone.js is not a file of its bundle')
  })

  it('node runs on gugu’s own runtime; ./x runs from the bundle; a bare name comes from PATH', () => {
    const rootDir = extensionFolder({})
    mkdirSync(join(rootDir, 'mcp'))
    writeFileSync(join(rootDir, 'mcp', 'server.mjs'), '')
    // 同级目录(名字恰好以扩展目录为前缀)不算「包内」,原样传。
    const sibling = `${rootDir}-evil`
    mkdirSync(sibling)
    writeFileSync(join(sibling, 'payload.js'), '')
    const escape = `../${sibling.split(/[\\/]/).pop()}/payload.js`
    const { programs } = extensionAgentPrograms([{
      extensionId: 'agent-notes',
      name: '随手记',
      rootDir,
      dataDir: '/data/agent-notes',
      digest: 'd1',
      disclosure: 'progressive',
      servers: [
        { name: 'agent-notes', command: 'node', args: ['mcp/server.mjs', escape] },
        { name: 'index', command: './bin/index' },
        { name: 'py', command: 'uvx', args: ['notes-mcp'], env: { NOTES_MODE: 'strict' } },
      ],
      skillsDir: null,
    }], host)

    const [node, bundled, onPath] = programs
    expect(programs.map(({ extensionId, server, digest, cwd }) => ({ extensionId, server, digest, cwd }))).toEqual(
      ['agent-notes', 'index', 'py'].map((server) => ({ extensionId: 'agent-notes', server, digest: 'd1', cwd: rootDir })),
    )
    expect([node!.command, ...node!.args]).toEqual([host.nodeExecutable, join(rootDir, 'mcp', 'server.mjs'), escape])
    expect([bundled!.command, ...bundled!.args]).toEqual([join(rootDir, 'bin/index')])
    expect([onPath!.command, ...onPath!.args]).toEqual(['uvx', 'notes-mcp'])
    expect(node!.env).toEqual({
      GUGU_EXTENSION_ID: 'agent-notes',
      GUGU_EXTENSION_DATA_DIR: '/data/agent-notes',
      GUGU_EXTENSION_LINK_BASE: 'gugu-dev://ext/agent-notes',
      GUGU_APP_SETTINGS: '{}',
      ELECTRON_RUN_AS_NODE: '1',
    })
    // #6634 问题 14 程序池在起程序前建的就是它被告知的那个数据目录。
    expect(programs.map((program) => program.dataDir)).toEqual(['/data/agent-notes', '/data/agent-notes', '/data/agent-notes'])
    // 只有咕咕自己的运行时要这个开关;别的程序继承它会跑偏。
    expect(onPath!.env).toMatchObject({ NOTES_MODE: 'strict' })
    expect(onPath!.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('a broken skill folder drops only that extension’s skills, loudly — the session still opens', () => {
    const onProblem = vi.fn()
    const result = extensionAgentPrograms([{
      extensionId: 'broken',
      name: 'broken',
      rootDir: '/nowhere',
      dataDir: '/data/broken',
      digest: 'd1',
      disclosure: 'progressive',
      servers: [{ name: 'broken', command: 'node', args: ['s.js'] }],
      skillsDir: '/nowhere/skills',
    }], { ...host, onProblem })
    expect(result.programs).toHaveLength(1)
    expect(result.skills).toEqual([])
    expect(onProblem).toHaveBeenCalledWith(expect.stringContaining('extension broken: skills folder cannot be read (/nowhere/skills): ENOENT'))
  })

  // 评审 824a8a6abc ①: `"skills": "SKILL.md"` names a file — reading it as a folder threw ENOTDIR, which nothing caught at
  // app_install and app_check. Said like any other skill problem, with the App, and nothing thrown.
  it('a skills path that is a file is said, with the App — not thrown', () => {
    const rootDir = extensionFolder({})
    writeFileSync(join(rootDir, 'SKILL.md'), OK_STAMP)
    const onProblem = vi.fn()
    expect(readExtensionSkills('flat', join(rootDir, 'SKILL.md'), onProblem)).toEqual([])
    expect(onProblem).toHaveBeenCalledWith(expect.stringContaining(`extension flat: skills folder cannot be read (${join(rootDir, 'SKILL.md')}): ENOTDIR`))
  })

  // skill 注入核查 10-14: one SKILL.md whose frontmatter did not parse took the App's other skill with it, and the main log
  // said only the YAML reader's words — no App, no file.
  it('a broken SKILL.md is left out alone: its sibling still reaches the session, and the problem names the App and the file', () => {
    const rootDir = extensionFolder({ 'bad-stamp': BAD_STAMP, 'ok-stamp': OK_STAMP })
    const onProblem = vi.fn()
    const { skills } = extensionAgentPrograms([{
      extensionId: 'skillx-bad', name: 'skillx-bad', rootDir, dataDir: '/data/skillx-bad', digest: 'd1', disclosure: 'progressive',
      servers: [], skillsDir: join(rootDir, 'skills'),
    }], { ...host, onProblem })
    expect(skills.map((skill) => skill.name)).toEqual(['ok-stamp'])
    expect(onProblem).toHaveBeenCalledTimes(1)
    const [message] = onProblem.mock.calls[0]!
    expect(message).toContain(`extension skillx-bad: skill bad-stamp left out of the session (${join(rootDir, 'skills', 'bad-stamp', 'SKILL.md')}): `)
    expect(message).toMatch(/Nested mappings are not allowed/)
  })
})

describe('extension skills are read from SKILL.md frontmatter (#6387)', () => {
  it('takes name and description; refuses a skill nobody could judge', () => {
    const root = extensionFolder({ 'agent-notes': NOTES_SKILL, 'no-name': '---\ndescription: "Quoted one"\n---\n' })
    const skills = readExtensionSkills('agent-notes', join(root, 'skills'), noProblem)
    expect(skills.map(({ name, description }) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'agent-notes', description: 'Save and search notes the person keeps in 随手记' },
      { name: 'no-name', description: 'Quoted one' },
    ])
    const bad = extensionFolder({ vague: '---\nname: vague\n---\n', 'agent-notes': NOTES_SKILL })
    const onProblem = vi.fn()
    expect(readExtensionSkills('x', join(bad, 'skills'), onProblem).map((skill) => skill.name)).toEqual(['agent-notes'])
    expect(onProblem).toHaveBeenCalledWith(`extension x: skill vague left out of the session (${join(bad, 'skills', 'vague', 'SKILL.md')}): its frontmatter has no description`)
  })

  it('reads a folded block description as its text, not as the marker `>-` (抽卡台\'s SKILL.md, A/B 10-10)', () => {
    const folded = '---\nname: choukatai\ndescription: >-\n  Work a card table: draw cards\n  with several agents.\n---\n# body\n'
    const [skill] = readExtensionSkills('choukatai', join(extensionFolder({ choukatai: folded }), 'skills'), noProblem)
    expect(skill?.description).toBe('Work a card table: draw cards with several agents.')
  })
})

function claudeBundle(extensionSkills: SessionCapabilityBundle['extensionSkills']): SessionCapabilityBundle {
  const authEnv = `GUGU_SESSION_MCP_AUTH_${GUGU_MCP_SERVER_NAME.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`
  return {
    mcpServers: [{ name: GUGU_MCP_SERVER_NAME, url: 'http://127.0.0.1:44100/mcp/probe', authorizationEnv: authEnv, alwaysLoad: true, owner: 'gugu' }],
    mcpDisabled: undefined,
    extensionSkills,
    env: { GUGU_HOME: '/tmp/gugu-6387', HOME: '/tmp/gugu-6387-user', [authEnv]: 'Bearer probe' },
    model: null,
    autonomy: null,
    promptBlocks: {},
    packages: PRODUCT_CAPABILITY_PACKAGES,
  }
}

describe('where extension skills reach the agent (#6387)', () => {
  const root = extensionFolder({ 'agent-notes': NOTES_SKILL })
  const skills = readExtensionSkills('agent-notes', join(root, 'skills'), noProblem)

  it('claude mounts them into its per-session plugin folder, and the folder changes with them', () => {
    const behavior = pluginRegistry.get('claude')!.behavior.sessionBundle!
    const ctx = { surface: 'acp' as const, lifecycle: 'fresh' as const, cwd: '/tmp/gugu-6387-ws' }
    const withSkills = behavior.materialize(ctx, claudeBundle(skills))
    const without = behavior.materialize(ctx, claudeBundle([]))

    expect(withSkills.symlinks).toHaveLength(1)
    const [link] = withSkills.symlinks!
    expect(link.sourcePath).toBe(join(root, 'skills', 'agent-notes'))
    expect(link.path).toMatch(/capability-packages\/claude\/gugu-product\/[^/]+\/skills\/agent-notes-agent-notes$/)
    expect(without.symlinks).toEqual([])
    // 卸掉扩展后新会话必须换一份目录,否则旧软链还躺在复用的目录里。
    const pluginDir = (m: typeof without) => m.artifacts.find((a) => a.path.endsWith('.mcp.json'))!.path
    expect(pluginDir(withSkills)).not.toBe(pluginDir(without))
  })

  it('exactly one path per harness: claude and codex mount them, the rest read the catalog in the platform block', () => {
    expect(mountsExtensionSkillsNatively(pluginRegistry.get('claude')!.capabilities.sessionBundle?.extension)).toBe(true)
    expect(mountsExtensionSkillsNatively(pluginRegistry.get('codex')!.capabilities.sessionBundle?.extension)).toBe(true)
    expect(mountsExtensionSkillsNatively(pluginRegistry.get('opencode')!.capabilities.sessionBundle?.extension)).toBe(false)
  })

  it('the block names each skill, says when to use it and where its SKILL.md is', () => {
    const block = guguAppsBlock([], skills)
    expect(block).toContain('<gugu_apps>')
    expect(block).not.toContain('gugu_app_skills')
    expect(block).toContain('- agent-notes (App agent-notes): Save and search notes the person keeps in 随手记')
    expect(block).toContain(join(root, 'skills', 'agent-notes', 'SKILL.md'))
    expect(guguAppsBlock([], [])).toBe('')
    // 10-19 Last, the one line on Apps the opening could not list: where to look for them.
    expect(block.endsWith(`${GUGU_APPS_SEARCH_LINE}\n</gugu_apps>\n`)).toBe(true)
  })
})

describe('上下文工程第二批 P3: <gugu_apps> names the Apps that give a session programs or skills (D-27; owner 10-31: 600, overflow by name)', () => {
  const omnisearch = { extensionId: 'omnisearch', name: '全能搜索', instructions: 'omnisearch__search(query)、read(url)、docs(library, query)：网页搜索、读网页、查编程库文档。' }
  const skills = readExtensionSkills('agent-notes', join(extensionFolder({ 'agent-notes': NOTES_SKILL }), 'skills'), noProblem)
  const appLinesOf = (block: string) => block.split('\n').filter((line) => line.startsWith('- '))

  it('one line per App: its name, its id and its instructions, whole', () => {
    const long = { extensionId: 'long', name: 'Long', instructions: `${'一'.repeat(159)}。` }
    const block = guguAppsBlock([omnisearch, long], [])
    expect(appLinesOf(block)).toEqual([`- 全能搜索 (omnisearch): ${omnisearch.instructions}`, `- Long (long): ${long.instructions}`])
    expect(block).toContain('Apps available in this session (use their listed tools, or catalog_list / catalog_call):')
  })

  it('the App lines stay within 600 units; the ones left out are still named, in order, with name and id', () => {
    const apps = Array.from({ length: 20 }, (_, index) => ({ extensionId: `app-${index}`, name: `App ${index}`, instructions: `${'用'.repeat(60)}。` }))
    const lines = appLinesOf(guguAppsBlock(apps, []))
    expect(GUGU_APPS_LINES_TOKEN_BUDGET).toBe(600)
    expect(estimatePromptTokens(lines.join('\n'))).toBeLessThanOrEqual(GUGU_APPS_LINES_TOKEN_BUDGET)
    const shown = lines.length - 1
    expect(shown).toBeGreaterThan(0)
    expect(lines.slice(0, shown).map((line) => line.slice(2, line.indexOf(' (')))).toEqual(apps.slice(0, shown).map((app) => app.name))
    const rest = apps.slice(shown).map((app) => `${app.name} (${app.extensionId})`).join(', ')
    expect(lines.at(-1)).toBe(`- …more Apps: ${rest}; catalog_list for details`)
    // Not cut too early (复核 84 4(c)): showing one more App in full would go past the budget.
    const nextLine = appLinesOf(guguAppsBlock([apps[shown]!], []))[0]!
    const oneMore = [...lines.slice(0, shown), nextLine, `- …more Apps: ${apps.slice(shown + 1).map((app) => `${app.name} (${app.extensionId})`).join(', ')}; catalog_list for details`]
    expect(estimatePromptTokens(oneMore.join('\n'))).toBeGreaterThan(GUGU_APPS_LINES_TOKEN_BUDGET)
    // Thirteen typical Apps fit whole.
    expect(appLinesOf(guguAppsBlock(Array.from({ length: 13 }, (_, index) => ({ ...omnisearch, extensionId: `o-${index}` })), []))).toHaveLength(13)
  })

  it('names every App even when the names alone run past the budget', () => {
    const apps = Array.from({ length: 200 }, (_, index) => ({ extensionId: `app-${index}`, name: `App ${index}`, instructions: '用'.repeat(160) }))
    const lines = appLinesOf(guguAppsBlock(apps, []))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('App 0 (app-0), ')
    expect(lines[0]).toContain('App 199 (app-199); catalog_list for details')
  })

  it('names the Apps whose programs run or whose skills are read, native or catalog alike (复核 84 2(d))', () => {
    const rootDir = extensionFolder({})
    writeFileSync(join(rootDir, 'tools.js'), 'export const follow = {}')
    const app = (extensionId: string, tools: string | null, disclosure: 'progressive' | 'full', skillsDir: string | null = null) => ({
      extensionId, name: `App ${extensionId}`, instructions: `${extensionId} line`, rootDir, dataDir: `/data/${extensionId}`,
      digest: 'd1', disclosure, servers: tools ? [{ tools }] : [], skillsDir,
    })
    const contributions = [
      app('board', 'tools.js', 'progressive'),
      app('gone', 'lib/gone.js', 'progressive'), // its tools module is not in the bundle: no program, nothing runs
      app('listed', 'tools.js', 'full'),
      app('notes', null, 'progressive', join(rootDir, 'skills')),
      { ...app('page', null, 'progressive'), instructions: undefined },
    ]
    const host = {
      nodeExecutable: '/Applications/咕咕.app/Contents/MacOS/咕咕',
      toolsRuntime: '/Applications/咕咕.app/Contents/Resources/app-runtime/gugu-tools.mjs',
      linkPrefix: 'gugu-dev://ext',
      onProblem: vi.fn(),
    }
    const { programs } = extensionAgentPrograms(contributions, host)
    expect(agentAppsOf(contributions, programs)).toEqual([
      { extensionId: 'board', name: 'App board', instructions: 'board line' },
      { extensionId: 'listed', name: 'App listed', instructions: 'listed line' },
      { extensionId: 'notes', name: 'App notes', instructions: 'notes line' },
    ])
  })

  it('Apps and skills share the one block', () => {
    const block = guguAppsBlock([omnisearch], skills)
    expect(block.match(/<gugu_apps>/g)).toHaveLength(1)
    expect(block).toContain('- 全能搜索 (omnisearch)')
    expect(block).toContain('- agent-notes (App agent-notes)')
  })
})

describe('what the /mcp panel is told this session got from extensions (#6387)', () => {
  it('each program and each skill, with the extension it came from — nothing else from the bundle', () => {
    const bundle = {
      extensionServerOrigins: [{ name: 'agent-notes', extensionId: 'agent-notes' }],
      extensionSkills: [{ extensionId: 'agent-notes', name: 'agent-notes', description: 'd', dir: '/x/skills/agent-notes' }],
    } as unknown as Parameters<typeof sessionExtensionDelivery>[0]
    expect(sessionExtensionDelivery(bundle)).toEqual({
      servers: [{ name: 'agent-notes', extensionId: 'agent-notes' }],
      skills: [{ name: 'agent-notes', extensionId: 'agent-notes' }],
    })
  })
})

describe('a secret in a codex stdio program’s env (#6387 review)', () => {
  // 聊天面板这条腿的片段走进程 env → 桥 → thread-open,同一系统用户之外谁也读不到,所以写真值;
  // 终端那条腿把配置铺成 `-c` argv,本机谁都列得出来 ⇒ 走 Codex 自己的 env_vars:值进会话进程 env,argv 只有名字。
  const bundle: SessionCapabilityBundle = {
    mcpServers: [
      { name: 'gugu', url: 'http://127.0.0.1:44100/mcp', authorizationEnv: 'SOURCE_BEARER' },
      { name: 'vault', transport: 'stdio', command: 'vault-mcp', env: { VAULT_TOKEN: 'GUGU_SESSION_MCP_ENV_VAULT_TOKEN' }, owner: 'user' },
    ],
    env: { GUGU_HOME: '/tmp/gugu-6387', SOURCE_BEARER: 'Bearer capability', GUGU_SESSION_MCP_ENV_VAULT_TOKEN: 's3cret' },
    model: null,
    autonomy: null,
    promptBlocks: {},
    packages: [CODEX_GUGU_CAPABILITY_PACKAGE],
  }

  it('the chat leg hands the program the real value', () => {
    const materialized = materializeCodexSessionBundle(
      { surface: 'acp', lifecycle: 'fresh', cwd: '/tmp/gugu-6387-ws' },
      bundle,
    )
    const fragment = JSON.parse(materialized.env.GUGU_CODEX_MCP_CONFIG ?? '{}') as Record<string, Record<string, unknown>>
    expect(fragment.vault).toMatchObject({ env: { VAULT_TOKEN: 's3cret' } })
  })

  it('the terminal leg hands it over with Codex’s env_vars: the value in the session’s env, only the name in argv', () => {
    const { threadConfig, env } = materializeCodexSessionBundle(
      { surface: 'app-server', lifecycle: 'fresh', cwd: '/tmp/gugu-6387-ws' },
      bundle,
    )
    expect(JSON.stringify(threadConfig)).not.toContain('s3cret')
    expect(JSON.stringify(threadConfig)).not.toContain('${')
    expect(threadConfig).toMatchObject({ 'mcp_servers.vault.env_vars': ['VAULT_TOKEN'] })
    expect(env.VAULT_TOKEN).toBe('s3cret')
  })

  it('a name Codex reads itself is refused, not overwritten', () => {
    const clash: SessionCapabilityBundle = {
      ...bundle,
      mcpServers: [bundle.mcpServers[0]!, { name: 'vault', transport: 'stdio', command: 'vault-mcp', env: { OPENAI_API_KEY: 'GUGU_SESSION_MCP_ENV_VAULT_TOKEN' }, owner: 'user' }],
    }
    expect(() => materializeCodexSessionBundle(
      { surface: 'app-server', lifecycle: 'fresh', cwd: '/tmp/gugu-6387-ws' },
      clash,
    )).toThrow(/OPENAI_API_KEY/)
  })
})


describe('App instructions: an App\'s one line for agents', () => {
  it('reaches real harness instruction payloads without reading a skill', () => {
    const base = {
      mcpServers: [], mcpDisabled: undefined, env: { GUGU_HOME: '/tmp/calendar-instructions' },
      model: null, autonomy: null, promptBlocks: { platform: 'Platform.' }, packages: PRODUCT_CAPABILITY_PACKAGES,
      extensionSkills: [], extensionServerOrigins: [],
      extensionApps: [{ extensionId: 'calendar', name: 'Calendar', instructions: 'AUTO-RECORD-TENNIS' }],
    };
    const ctx = { cwd: '/tmp/calendar-instructions', lifecycle: 'fresh' as const };
    expect(loadCodexAppServerCapabilities(base, ctx).developerInstructions).toContain('- Calendar (calendar): AUTO-RECORD-TENNIS');
    expect(loadClaudeTuiCapabilities(base, ctx).artifacts?.some((a) => a.content.includes('AUTO-RECORD-TENNIS'))).toBe(true);
    expect(loadSessionTuiCapabilities('pi', base, ctx).spawnEnv?.GUGU_PI_SYSTEM_PROMPT).toContain('AUTO-RECORD-TENNIS');
    expect(JSON.stringify(loadCodexAppServerCapabilities({ ...base, extensionApps: [] }, ctx))).not.toContain('AUTO-RECORD-TENNIS');
  });

  it('is required with programs or skills, refused without, at most 160 characters', () => {
    const manifest = { id: 'calendar', name: 'Calendar', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'main.html',
      permissions: { capabilities: ['agents:tools'] },
      contributes: { tabs: [{ name: 'main', title: 'Calendar', entry: 'main.html' }], mcpServers: [{ tools: 'tools.js' }], instructions: 'calendar__add(when, what): record plans.' } };
    expect(safeParseExtensionManifest(manifest).ok).toBe(true);
    expect(safeParseExtensionManifest({ ...manifest, permissions: { capabilities: [] } }).ok).toBe(false);
    for (const instructions of ['', ' '.repeat(10), 'x'.repeat(161), undefined]) {
      expect(safeParseExtensionManifest({ ...manifest, contributes: { ...manifest.contributes, instructions } }).ok).toBe(false);
    }
    expect(safeParseExtensionManifest({ ...manifest, contributes: { ...manifest.contributes, instructions: 'x'.repeat(160) } }).ok).toBe(true);
    const { mcpServers: _programs, ...pageOnly } = manifest.contributes;
    expect(safeParseExtensionManifest({ ...manifest, permissions: {}, contributes: pageOnly }).ok).toBe(false);
    expect(safeParseExtensionManifest({ ...manifest, contributes: { ...manifest.contributes, agentInstructions: 'gone' } }).ok).toBe(false);
  });
});

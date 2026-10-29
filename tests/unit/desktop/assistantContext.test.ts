import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { assistantGuide, assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import { ASSISTANT_CONTEXT_CORE, ASSISTANT_TASK_EXECUTION } from '@gugu/core/shared/assistantWorkflow'
import { openingAssistantIndex } from '../../../apps/desktop/electron/sessionpage/assistant-index-cache'
import { boundedAssistantIndex } from '../../../apps/desktop/electron/sessionpage/assistant-index-format'
import { GUGU_ACKNOWLEDGEMENT, GUGU_PLATFORM_BLOCK } from '../../../apps/desktop/electron/product-platform-prompt'
import type { Materialization } from '../../../apps/desktop/electron/capability-bundle'
import { assistantHomeTaskContext, personalAssistantContext, preparePersonalAssistantContext, refreshAssistantContext } from '../../../apps/desktop/electron/sessionpage/assistant-context'

it('keeps the resident coordination policy within 1300 characters', () => {
  expect(ASSISTANT_CONTEXT_CORE.join('\n').length).toBeLessThanOrEqual(1_300)
})

function fixture(): Materialization {
  return {
    report: {} as Materialization['report'],
    sessionPrompt: 'identity and product rules',
    spawnEnv: { GUGU_SESSION_MCP_AUTH_GUGU: 'private-sentinel' },
    artifacts: [
      { path: '/caps/.claude-plugin/plugin.json', content: '{"name":"gugu-product"}', mode: 0o644 },
      { path: '/caps/.mcp.json', content: JSON.stringify({ mcpServers: { gugu: {
        type: 'http', url: '${GUGU_SESSION_MCP_URL_GUGU}', headers: { Authorization: '${GUGU_SESSION_MCP_AUTH_GUGU}' },
      } } }), mode: 0o600 },
    ],
    sessionNewPatch: { meta: { claudeCode: { options: {
      plugins: [{ type: 'local', path: '/caps' }], disallowedTools: ['AskUserQuestion'],
      env: { KEEP_THIS: 'yes' }, settings: '/private/model.json',
    } } } },
  }
}

async function hookIndex(materialization: Materialization, index = 'current-index'): Promise<string> {
  const hook = materialization.artifacts!.find(file => file.path.endsWith('/startup.cjs'))!
  const transport = `global.fetch = async (_url, options) => {
    const request = options.body ? JSON.parse(options.body) : {};
    const result = request.method === 'resources/read' ? { contents: [{ text: ${JSON.stringify(index)} }] } : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' }
    });
  };\n`
  const result = await runEventHook(transport + hook.content, { hook_event_name: 'SessionStart', source: 'startup' },
    { ...process.env, GUGU_SESSION_MCP_URL_GUGU: 'http://127.0.0.1:1/mcp', GUGU_SESSION_MCP_AUTH_GUGU: 'isolated-test' })
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  const output = JSON.parse(result.stdout)
  expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
  return output.hookSpecificOutput.additionalContext
}

function runEventHook(script: string, event: { hook_event_name: string; source: string }, env = process.env) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
    child.stdin.end(JSON.stringify(event))
  })
}

it.each(['computer', 'cloud'] as const)('keeps the complete %s handbook retrievable without loading it into every greeting', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-context-'))
  try {
    const cwd = join(root, kind === 'computer' ? 'assistant' : 'cloud-home')
    await mkdir(cwd)
    await mkdir(join(root, '.claude'))
    const instructions = assistantHomePaths(root, cwd, kind).instructions
    const full = assistantGuide(kind)
    const outdated = full.replaceAll('profile_rules: 6', 'profile_rules: 1').replaceAll('关于你v3', '关于你v1')
      .replace('你是个人助理', '你是主人的个人代理，电脑睡了或关了以后再处理')
    expect(outdated).toContain('profile_rules: 1')
    await writeFile(instructions, `Owner instructions before\n${outdated}\nOwner instructions after`)
    await writeFile(join(cwd, 'memory.md'), 'durable owner memory')
    await refreshAssistantContext(cwd, root, kind, root)
    const brief = await readFile(instructions, 'utf8')
    expect(brief).toContain('Owner instructions before')
    expect(brief).toContain('Owner instructions after')
    expect(brief).toContain('明确要求当作任务')
    expect(brief).toContain('宿主自动补齐执行约定')
    expect(brief).toContain('关于你：按宿主整理要求处理，不自行重查版本。')
    expect(full).toContain('不依赖模型碰巧读到索引')
    // An upgrade must expose the version gate even after today's first conversation.
    expect(brief).toContain('按宿主整理要求处理，不自行重查版本')
    expect(brief).not.toContain('profile_rules: 1')
    expect(brief).not.toContain('关于你v1')
    expect(brief).toContain('同版寒暄直接回复')
    expect(full).toContain('即使当天已聊过，缺失/不同仍在下一轮整理')
    // Both the resident instructions and the on-demand handbook carry the owner-facing boundary.
    for (const text of [brief, full]) {
      expect(text).not.toMatch(/主人|用户|电脑睡|机器睡|叫醒/)
      expect(text).toContain('不展示会话、work、设备、job 的内部编号')
      expect(text).toContain('Pi 运行时、ACP')
      expect(text).toContain('用任务标题、设备名和可点击链接')
      expect(text).toContain('不说「我猜」')
      expect(text).toContain('不要求核对完整 ID')
      expect(text).toContain('先查原记录')
      expect(text).toContain('仍查不到就说明已知事实与缺口')
      expect(text).toContain('做好了但交不回')
    }
    expect(brief).toContain("Don't ask by default")
    expect(brief).toContain('明确要求先问后做时照办')
    expect(brief).toContain('缺授权的花钱、对外发送、删除或改动')
    expect(brief).toContain('.gugu-assistant-reference.md')
    expect(brief).not.toContain('"batches"')
    expect(brief.length).toBeLessThan(full.length / 2)
    expect(await readFile(join(cwd, '.gugu-assistant-reference.md'), 'utf8')).toBe(full)
    expect(full).not.toContain(ASSISTANT_TASK_EXECUTION)
    const materialized = personalAssistantContext(fixture(), kind)
    const options = (materialized.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
    const effective = (options.systemPrompt as { prompt: string }).prompt + '\n' + brief
    for (const rule of ASSISTANT_CONTEXT_CORE.slice(1)) expect(effective.split(rule)).toHaveLength(2)
    expect(effective).not.toContain('Read the assistant handbook before delegation')
    expect(await readFile(join(cwd, 'memory.md'), 'utf8')).toBe('durable owner memory')
    if (kind === 'cloud') await expect(readFile(join(cwd, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('removes only the assistant acknowledgement duplicate from the actual custom system channel', () => {
  const before = fixture()
  before.sessionPrompt = `identity-before\n${GUGU_PLATFORM_BLOCK}\nidentity-after`
  const after = personalAssistantContext(before, 'cloud')
  const options = (after.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
  const system = options.systemPrompt as { type: string; prompt: string }
  expect(system.type).toBe('custom')
  expect(system.prompt).not.toContain(GUGU_ACKNOWLEDGEMENT)
  expect(system.prompt).toContain('identity-before')
  expect(system.prompt).toContain('identity-after')
  expect(system.prompt).toContain('Short. Lead with the answer')
  expect(before.sessionPrompt).toContain(GUGU_ACKNOWLEDGEMENT)
})

it('loads the dedicated cloud home where the assistant guide and skills actually live', () => {
  const after = personalAssistantContext(fixture(), 'cloud')
  const options = (after.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
  expect(options.settingSources).toEqual(['user', 'project', 'local'])
  expect(options.strictMcpConfig).toBe(true)
})

it('enables host idle compaction only for a prepared personal assistant, never its home executors', () => {
  const prepared = personalAssistantContext(fixture(), 'cloud', { index: '<gugu_resource_index />', guguHome: '/gugu' })
  expect(prepared.sessionNewPatch!.meta!.guguAssistant).toEqual({ idleCompaction: true })
  expect(personalAssistantContext(fixture()).sessionNewPatch!.meta!.guguAssistant).toBeUndefined()
  const childSource = fixture()
  childSource.sessionNewPatch!.meta!.guguAssistant = { idleCompaction: true }
  const child = assistantHomeTaskContext(childSource, '/gugu/assistant', '/gugu')
  expect(child.sessionNewPatch!.meta!.guguAssistant).toBeUndefined()
})

it('keeps home executors isolated while the host supplies the contract in their work order, auto memory or recovery subscriptions', () => {
  const before = fixture()
  expect(assistantHomeTaskContext(before, '/business', '/gugu')).toBe(before)
  const after = assistantHomeTaskContext(before, '/gugu/assistant', '/gugu')
  const options = (after.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
  expect(options.systemPrompt).not.toContain(ASSISTANT_TASK_EXECUTION)
  expect(options.systemPrompt).toContain(before.sessionPrompt)
  expect(typeof options.systemPrompt).toBe('string')
  expect(options.settingSources).toEqual([])
  expect(options.tools).toContain('Bash')
  // A delegated task loads the skills of connected CLI applications; the assistant itself never gets Bash or Skill.
  expect(options.tools).toContain('Skill')
  expect(options.env).toMatchObject({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', KEEP_THIS: 'yes' })
  expect(options.env).not.toHaveProperty('ENABLE_TOOL_SEARCH')
  expect(options.settings).toBe('/private/model.json')
  expect(options.mcpServers).toHaveProperty('plugin_gugu-product_gugu')
  expect(after.artifacts).toEqual(before.artifacts)
  expect(JSON.stringify(after.artifacts)).not.toContain('recovery.cjs')
})

it('preserves executor tool-search choices without inheriting the assistant override', () => {
  for (const value of ['true', 'auto:5']) {
    const capabilities = fixture()
    const claude = capabilities.sessionNewPatch!.meta!.claudeCode as { options: { env: Record<string, string> } }
    claude.options.env.ENABLE_TOOL_SEARCH = value
    const executor = assistantHomeTaskContext(capabilities, '/gugu/assistant', '/gugu')
    const options = (executor.sessionNewPatch!.meta!.claudeCode as { options: { env: Record<string, string> } }).options
    expect(options.env.ENABLE_TOOL_SEARCH).toBe(value)
    for (const kind of ['cloud', 'computer'] as const) {
      const assistant = personalAssistantContext(capabilities, kind)
      expect((assistant.sessionNewPatch!.meta!.claudeCode as { options: { env: Record<string, string> } }).options.env.ENABLE_TOOL_SEARCH).toBe('false')
    }
    expect(claude.options.env.ENABLE_TOOL_SEARCH).toBe(value)
  }
})

it('excludes ancestor coding instructions without changing the assistant settings or its own guide', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-boundary-'))
  try {
    const cwd = join(root, 'assistant')
    await mkdir(join(cwd, '.claude'), { recursive: true })
    const settingsPath = join(cwd, '.claude/settings.json')
    await writeFile(settingsPath, JSON.stringify({ permissions: { deny: ['CronCreate'] }, model: 'keep-model', claudeMdExcludes: ['/custom/excluded.md'] }))
    await refreshAssistantContext(cwd, root, 'computer', root)
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(settings.permissions).toEqual({ deny: ['CronCreate'] })
    expect(settings.model).toBe('keep-model')
    expect(settings.claudeMdExcludes).toContain('/custom/excluded.md')
    expect(settings.claudeMdExcludes).toContain(join(root, '.claude/CLAUDE.md'))
    expect(settings.claudeMdExcludes).toContain(join(root, '.claude/rules/**'))
    expect(settings.claudeMdExcludes).not.toContain(join(cwd, 'CLAUDE.md'))
    expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toContain('超级个人代理')
    await refreshAssistantContext(cwd, root, 'computer', root)
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(settings)
    await writeFile(settingsPath, '{broken')
    await expect(refreshAssistantContext(cwd, root, 'computer', root)).rejects.toThrow()
    expect(await readFile(settingsPath, 'utf8')).toBe('{broken')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('uses built-in Gugu indexes without requiring an external library installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-library-'))
  try {
    const cwd = join(root, 'assistant'); await mkdir(cwd); await mkdir(join(root, '.claude'))
    const config = join(root, '.claude/autolibrary.json')
    await writeFile(config, JSON.stringify({ volumes: ['memory', 'workspace', 'capabilities', 'devices', 'ideas'].map(name => ({ name, path: join(root, name) })) }))
    await refreshAssistantContext(cwd, root, 'computer', root)
    const brief = await readFile(join(cwd, 'CLAUDE.md'), 'utf8')
    expect(brief).not.toContain(config)
    expect(brief).toContain('按当前账号独立保存')
    expect(brief).toContain('project_list / project_get')
    expect(brief).toContain('无需安装其他索引工具')
    expect(brief).not.toContain(join(root, 'ideas'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('serializes concurrent initialization without sharing temporary files or losing owner instructions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-concurrent-'))
  try {
    const cwd = join(root, 'assistant'); await mkdir(cwd)
    await writeFile(join(cwd, 'CLAUDE.md'), 'Owner instructions stay intact\n')
    await Promise.all(Array.from({ length: 12 }, () => refreshAssistantContext(cwd, root, 'computer', root)))
    const instructions = await readFile(join(cwd, 'CLAUDE.md'), 'utf8')
    expect(instructions).toContain('Owner instructions stay intact')
    expect(instructions.match(/# 超级个人代理/g)).toHaveLength(1)
    expect(await readFile(join(cwd, '.gugu-assistant-reference.md'), 'utf8')).toBe(assistantGuide('computer'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('loads the assistant project and explicit Gugu tools without the host coding tools', () => {
  const before = fixture()
  const after = personalAssistantContext(before)
  const options = (after.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
  expect(options.settingSources).toEqual(['project', 'local'])
  expect(options.strictMcpConfig).toBe(true)
  expect(options.effort).toBe('low')
  expect(options.tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'])
  expect(options.mcpServers).toEqual({ 'plugin_gugu-product_gugu': {
    type: 'http', url: '${GUGU_SESSION_MCP_URL_GUGU}', headers: { Authorization: '${GUGU_SESSION_MCP_AUTH_GUGU}' },
  } })
  expect(JSON.stringify(options.mcpServers)).not.toContain('private-sentinel')
  expect(options.settings).toBe('/private/model.json')
  expect(options.disallowedTools).toEqual(['AskUserQuestion'])
  expect(options.env).toEqual({ KEEP_THIS: 'yes', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000', ENABLE_TOOL_SEARCH: 'false' })
  expect(after.sessionPrompt).toBe(before.sessionPrompt)
  expect(options.systemPrompt).toMatchObject({ type: 'custom', snapshot: false })
  const prompt = (options.systemPrompt as { prompt: string }).prompt
  expect(prompt).toContain('Follow the owner’s instructions, the managed project instructions and the platform contract.')
  expect(prompt.split(before.sessionPrompt!).length).toBe(2)
  expect(after.spawnEnv).toBe(before.spawnEnv)
  expect((before.sessionNewPatch!.meta!.claudeCode as { options: object }).options).not.toHaveProperty('strictMcpConfig')
})

it('keeps the native plugin and static prefix stable when only the resource inventory changes', () => {
  const make = (index: string) => personalAssistantContext(fixture(), 'computer', { index, guguHome: '/isolated-home' })
  const first = make('<gugu_resource_index>old inventory</gugu_resource_index>')
  const next = make('<gugu_resource_index>new inventory</gugu_resource_index>')
  expect(next.sessionNewPatch).toEqual(first.sessionNewPatch)
  expect(next.artifacts).toEqual(first.artifacts)
})

it('retains an explicit reasoning choice', () => {
  const chosen = fixture()
  const claude = chosen.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }
  claude.options.effort = 'high'
  claude.options.systemPrompt = 'explicit system instructions'
  const after = personalAssistantContext(chosen)
  const actual = after.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }
  expect(actual.options.effort).toBe('high')
  expect(actual.options.systemPrompt).toEqual({ type: 'custom', prompt: 'explicit system instructions', snapshot: false })
})

it('keeps explicit preset and custom prompt content while disabling only assistant snapshots', () => {
  for (const systemPrompt of [
    { type: 'preset', preset: 'claude_code', append: 'owner policy', snapshot: true },
    { type: 'custom', prompt: ['owner policy', 'platform policy'] },
  ]) {
    const before = fixture()
    const options = (before.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
    options.systemPrompt = systemPrompt
    const after = personalAssistantContext(before)
    const actual = (after.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
    expect(actual.systemPrompt).toEqual({ ...systemPrompt, snapshot: false })
    expect(options.systemPrompt).toBe(systemPrompt)
  }
})

it.each(['computer', 'cloud'] as const)('installs one full resource hook for startup/clear/compact and none on %s resume', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-start-'))
  try {
    const cwd = join(root, 'assistant'); await mkdir(cwd); await mkdir(join(root, '.claude'))
    const deps = { accountId: async () => 'owner', run: async (action: { action: string }) =>
      action.action === 'devices' ? [] : action.action === 'device_actions' ? { devices: [] }
        : action.action === 'project_list' ? [] : { items: [] } }
    const start = await preparePersonalAssistantContext(fixture(), cwd, root, kind, deps, root)
    const hooks = JSON.parse(start.artifacts!.find(file => file.path.endsWith('/hooks/hooks.json'))!.content).hooks.SessionStart
    for (const source of ['startup', 'clear', 'compact', 'resume']) {
      const resource = hooks.filter((entry: { matcher: string }) => new RegExp(`^(?:${entry.matcher})$`).test(source))
        .flatMap((entry: { hooks: Array<{ command: string }> }) => entry.hooks)
        .filter((hook: { command: string }) => /\/(?:startup|rebuild)\.cjs/.test(hook.command))
      expect(resource).toHaveLength(source === 'resume' ? 0 : 1)
    }
    expect((start.sessionNewPatch!.meta!.claudeCode as { options: { systemPrompt: { prompt: string } } }).options.systemPrompt.prompt)
      .not.toContain('gugu_resource_index')
    expect(start.sessionNewPatch!.meta!.guguAssistant).toMatchObject({ ownerId: 'owner' })
    await (await openingAssistantIndex(root, cwd, kind, deps)).refreshed
    expect(await readFile(assistantHomePaths(root, cwd, kind).instructions, 'utf8')).not.toContain('gugu_resource_index')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('uses a native context hook while retaining explicit string and preset system prompts', async () => {
  const chosen = fixture()
  const options = (chosen.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
  for (const prompt of ['explicit instructions', { type: 'preset', preset: 'claude_code', append: 'explicit instructions' }]) {
    options.systemPrompt = prompt
    const after = personalAssistantContext(chosen, 'computer', { index: 'fresh-index', guguHome: '/home/gugu' })
    const actual = (after.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
    expect(actual.systemPrompt).toEqual(typeof prompt === 'string'
      ? { type: 'custom', prompt, snapshot: false }
      : { ...prompt, snapshot: false })
    expect(await hookIndex(after, 'fresh-index')).toContain('fresh-index')
  }
})

it('installs the deleted-file guard without replacing the native prompt or conversation', () => {
  const base = { index: 'fresh-index', guguHome: '/home/gugu' }
  const before = personalAssistantContext(fixture(), 'computer', base)
  const after = personalAssistantContext(fixture(), 'computer', { ...base, panelStatePath: '/private/memory/.panel-state.json' })
  const options = (value: Materialization) => (value.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
  expect(options(after).systemPrompt).toEqual(options(before).systemPrompt)
  expect(after.sessionPrompt).toEqual(before.sessionPrompt)
  const hooks = JSON.parse(after.artifacts!.find(file => file.path.endsWith('/hooks/hooks.json'))!.content).hooks
  expect(hooks.PreToolUse).toContainEqual(expect.objectContaining({ matcher: 'Read|Write|Edit' }))
  const guard = after.artifacts!.find(file => file.path.endsWith('/revocation.cjs'))!
  expect(guard.mode).toBe(0o600)
  expect(guard.content).toContain('/private/memory/.panel-state.json')
})

it('delivers a large resource collection as one bounded native hook output with explicit omissions', async () => {
  const lines = ['<gugu_resource_index>', JSON.stringify({ account: 'user:owner' }), JSON.stringify({ source: 'projects',
    read: { tool: 'project_list' }, items: Array.from({ length: 180 }, (_, i) => ({
      id: `project:${i}`, name: `项目-${i}-😀`, path: `/Users/owner/projects/${i}`, description: 'x'.repeat(150),
    })) }), '</gugu_resource_index>']
  const index = boundedAssistantIndex(lines)
  const prepared = personalAssistantContext(fixture(), 'computer', { index, guguHome: '/home/gugu' })
  const scripts = prepared.artifacts!.filter(file => /\/startup(?:-\d+)?\.cjs$/.test(file.path))
  expect(scripts).toHaveLength(1)
  expect(await hookIndex(prepared, index)).toContain(index)
  expect(index.length).toBeLessThanOrEqual(6_000)
  expect(index).toContain('omitted_items')
  const config = JSON.parse(prepared.artifacts!.find(file => file.path.endsWith('/hooks/hooks.json'))!.content)
  expect(config.hooks.SessionStart[0].hooks).toHaveLength(1)
  expect(() => personalAssistantContext(fixture(), 'computer', { index: 'x'.repeat(6_001), guguHome: '/home/gugu' }))
    .toThrow('single bounded snapshot')
})

it('keeps recovery instructions separate from data chunks and includes them once per recovery event', async () => {
  const recoveryContext = '宿主恢复指令：先读 /private/assistant/memory/working-context.md，再核对原任务。'
  const prepared = personalAssistantContext(fixture(), 'computer', {
    index: '<gugu_resource_index>current facts only</gugu_resource_index>', guguHome: '/home/gugu', recoveryContext,
  })
  const config = JSON.parse(prepared.artifacts!.find(file => file.path.endsWith('/hooks/hooks.json'))!.content)
  const script = prepared.artifacts!.find(file => file.path.endsWith('/recovery.cjs'))!
  expect(script.mode).toBe(0o600)
  expect(await hookIndex(prepared)).not.toContain(recoveryContext)
  expect(await hookIndex(prepared)).not.toContain('working-context.md')
  for (const source of ['resume', 'compact', 'clear', 'fork']) {
    const registered = config.hooks.SessionStart.filter((entry: { matcher: string }) => new RegExp(`^(?:${entry.matcher})$`).test(source))
      .flatMap((entry: { hooks: Array<{ command: string }> }) => entry.hooks).filter((hook: { command: string }) => hook.command.includes('/recovery.cjs'))
    expect(registered).toHaveLength(1)
    const actual = await runEventHook(script.content, { hook_event_name: 'SessionStart', source })
    expect(actual.status).toBe(0)
    expect(actual.stderr).toBe('')
    const outputs = actual.stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(outputs).toEqual([{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: recoveryContext } }])
  }
  for (const event of [{ hook_event_name: 'SessionStart', source: 'startup' }, { hook_event_name: 'UserPromptSubmit', source: 'compact' },
    { hook_event_name: 'PostToolUse', source: 'resume' }, { hook_event_name: 'PreCompact', source: 'compact' }]) {
    const actual = await runEventHook(script.content, event)
    expect(actual.status).toBe(0)
    expect(actual.stdout).toBe('')
    expect(actual.stderr).toBe('')
  }
})

it('does not share a mutable plugin artifact across recovery policies or memory paths', () => {
  const startup = { index: 'same-account-index', guguHome: '/home/gugu' }
  const artifact = (recoveryContext: string) => personalAssistantContext(fixture(), 'computer', { ...startup, recoveryContext })
    .artifacts!.find(file => file.path.endsWith('/recovery.cjs'))!
  const first = artifact('读取 /memory-a/working-context.md')
  expect(artifact('读取 /memory-a/working-context.md')).toEqual(first)
  expect(artifact('读取 /memory-b/working-context.md').path).not.toBe(first.path)
  expect(artifact('先读取 /memory-a/working-context.md，再核对来源').path).not.toBe(first.path)
  const pathA = personalAssistantContext(fixture(), 'computer', { ...startup, recoveryContext: 'same-policy', workingContextPath: '/a/working-context.md' })
  const pathB = personalAssistantContext(fixture(), 'computer', { ...startup, recoveryContext: 'same-policy', workingContextPath: '/b/working-context.md' })
  expect(pathA.artifacts!.find(file => file.path.endsWith('/recovery.cjs'))!.path)
    .not.toBe(pathB.artifacts!.find(file => file.path.endsWith('/recovery.cjs'))!.path)
  const differentServer = fixture()
  differentServer.artifacts!.find(file => file.path.endsWith('/.mcp.json'))!.content = JSON.stringify({
    mcpServers: { gugu: { type: 'http', url: 'http://127.0.0.1:43210/mcp', headers: { Authorization: '${GUGU_SESSION_MCP_AUTH_GUGU}' } } },
  })
  const moved = personalAssistantContext(differentServer, 'computer', { ...startup, recoveryContext: '读取 /memory-a/working-context.md' })
  expect(moved.artifacts!.find(file => file.path.endsWith('/recovery.cjs'))!.path).not.toBe(first.path)
})

it('removes a persisted early-compaction percentage instead of carrying the old 40k setting forward', () => {
  const chosen = fixture()
  const options = (chosen.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
  options.env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '40000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '75', KEEP_THIS: 'yes' }
  const next = (personalAssistantContext(chosen).sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
  expect(next.env).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000', KEEP_THIS: 'yes', ENABLE_TOOL_SEARCH: 'false' })
  expect(options.env).toHaveProperty('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', '75')
})

it('refuses to start a strict assistant without its actual Gugu tools', () => {
  const broken = fixture()
  broken.artifacts = []
  expect(() => personalAssistantContext(broken)).toThrow('missing its manifest or MCP config')
  broken.sessionNewPatch = { meta: { claudeCode: { options: {} } } }
  expect(() => personalAssistantContext(broken)).toThrow('no explicit Gugu capabilities')
})

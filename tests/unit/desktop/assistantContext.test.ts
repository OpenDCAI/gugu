import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { assistantGuide, assistantHomePaths, assistantRecoveryContext } from '@gugu/core/shared/assistantPolicy'
import { ASSISTANT_CONTEXT_CORE, ASSISTANT_TASK_EXECUTION } from '@gugu/core/shared/assistantWorkflow'
import { openingAssistantIndex } from '../../../apps/desktop/electron/sessionpage/assistant-index-cache'
import { boundedAssistantIndex } from '../../../apps/desktop/electron/sessionpage/assistant-index-format'
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

function hookIndex(materialization: Materialization): string {
  const hook = materialization.artifacts!.find(file => file.path.endsWith('/startup.cjs'))!
  const result = spawnSync(process.execPath, ['-e', hook.content], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  const output = JSON.parse(result.stdout)
  expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
  return output.hookSpecificOutput.additionalContext
}

function runEventHook(script: string, event: { hook_event_name: string; source: string }) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
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
    await writeFile(instructions, `Owner instructions before\n${full}\nOwner instructions after`)
    await writeFile(join(cwd, 'memory.md'), 'durable owner memory')
    await refreshAssistantContext(cwd, root, kind, root)
    const brief = await readFile(instructions, 'utf8')
    expect(brief).toContain('Owner instructions before')
    expect(brief).toContain('Owner instructions after')
    expect(brief).toContain('主人明确要求当作任务')
    expect(brief).toContain('宿主自动补齐执行约定')
    expect(brief).toContain("Don't ask by default")
    expect(brief).toContain('主人明确要求先问后做时照办')
    expect(brief).toContain('缺授权的花钱、对外发送、删除或改动')
    expect(brief).toContain('.gugu-assistant-reference.md')
    expect(brief).not.toContain('"batches"')
    expect(brief.length).toBeLessThan(full.length / 2)
    expect(await readFile(join(cwd, '.gugu-assistant-reference.md'), 'utf8')).toBe(full)
    expect(full).not.toContain(ASSISTANT_TASK_EXECUTION)
    const materialized = personalAssistantContext(fixture(), kind)
    const options = (materialized.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
    const effective = String(options.systemPrompt) + '\n' + brief
    for (const rule of ASSISTANT_CONTEXT_CORE.slice(1)) expect(effective.split(rule)).toHaveLength(2)
    expect(effective).not.toContain('Read the assistant handbook before delegation')
    expect(await readFile(join(cwd, 'memory.md'), 'utf8')).toBe('durable owner memory')
    if (kind === 'cloud') await expect(readFile(join(cwd, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('loads the dedicated cloud home where the assistant guide and skills actually live', () => {
  const after = personalAssistantContext(fixture(), 'cloud')
  const options = (after.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
  expect(options.settingSources).toEqual(['user', 'project', 'local'])
  expect(options.strictMcpConfig).toBe(true)
})

it('keeps home executors isolated while the host supplies the contract in their work order, auto memory or recovery subscriptions', () => {
  const before = fixture()
  expect(assistantHomeTaskContext(before, '/business', '/gugu')).toBe(before)
  const after = assistantHomeTaskContext(before, '/gugu/assistant', '/gugu')
  const options = (after.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
  expect(options.systemPrompt).not.toContain(ASSISTANT_TASK_EXECUTION)
  expect(options.systemPrompt).toContain(before.sessionPrompt)
  expect(options.settingSources).toEqual([])
  expect(options.tools).toContain('Bash')
  expect(options.env).toMatchObject({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', KEEP_THIS: 'yes' })
  expect(options.settings).toBe('/private/model.json')
  expect(options.mcpServers).toHaveProperty('plugin_gugu-product_gugu')
  expect(after.artifacts).toEqual(before.artifacts)
  expect(JSON.stringify(after.artifacts)).not.toContain('recovery.cjs')
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
  expect(options.env).toEqual({ KEEP_THIS: 'yes', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' })
  expect(after.sessionPrompt).toBe(before.sessionPrompt)
  expect(options.systemPrompt).toContain('personal assistant in Gugu')
  expect(String(options.systemPrompt).split(before.sessionPrompt!).length).toBe(2)
  expect(after.spawnEnv).toBe(before.spawnEnv)
  expect((before.sessionNewPatch!.meta!.claudeCode as { options: object }).options).not.toHaveProperty('strictMcpConfig')
})

it('retains an explicit reasoning choice', () => {
  const chosen = fixture()
  const claude = chosen.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }
  claude.options.effort = 'high'
  claude.options.systemPrompt = 'explicit system instructions'
  const after = personalAssistantContext(chosen)
  const actual = after.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }
  expect(actual.options.effort).toBe('high')
  expect(actual.options.systemPrompt).toBe('explicit system instructions')
})

it.each(['computer', 'cloud'] as const)('opens %s with an honest snapshot while fresh discovery continues, including on resume', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-start-'))
  vi.stubEnv('GUGU_CLOUD_COMPUTER', kind === 'cloud' ? '1' : '0')
  try {
    const cwd = join(root, 'assistant'); await mkdir(cwd); await mkdir(join(root, '.claude'))
    let name = 'first-project'
    const deps = {
      accountId: async () => 'owner',
      run: async (action: { action: string }) => action.action === 'devices' ? [{
        device_id: 'execution-host', label: 'Current host', platform: kind === 'cloud' ? 'linux' : 'darwin',
        online: true, last_seen_at: null, this_machine: true, kind: kind === 'cloud' ? 'server' : 'desktop',
        ...(kind === 'cloud' ? { cloud_computer: 'awake' } : {}),
      }]
        : action.action === 'device_actions' ? { devices: [] }
          : action.action === 'project_list' ? [{ project_id: 'p', name, path: '/work' }] : { items: [] },
    }
    const start = await preparePersonalAssistantContext(fixture(), cwd, root, kind, deps, root)
    const options = (start.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
    expect(options.systemPrompt).not.toContain('first-project')
    expect(hookIndex(start)).toContain('not_loaded')
    await (await openingAssistantIndex(root, cwd, kind, deps)).refreshed
    const warm = await preparePersonalAssistantContext(fixture(), cwd, root, kind, deps, root)
    expect(hookIndex(warm)).toContain('first-project')
    const devices = hookIndex(warm).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    expect(devices.find(row => row.account)?.execution_environment).toBe(kind === 'cloud' ? 'cloud' : 'user_device')
    const executionHost = devices.find(row => row.device_id === 'device:execution-host')
    expect(executionHost).toMatchObject({ this_machine: true })
    if (kind === 'cloud') expect(executionHost).toHaveProperty('cloud_computer', 'awake')
    else expect(executionHost).not.toHaveProperty('cloud_computer')
    expect(options.systemPrompt).toContain('identity and product rules')
    expect(start.sessionPrompt).toBe('identity and product rules')
    await (await openingAssistantIndex(root, cwd, kind, deps)).refreshed
    name = 'renamed-project'
    const resumed = await preparePersonalAssistantContext(fixture(), cwd, root, kind, deps, root)
    const next = (resumed.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
    expect(hookIndex(resumed)).toContain('first-project')
    expect(hookIndex(resumed)).toContain('cached')
    await (await openingAssistantIndex(root, cwd, kind, deps)).refreshed
    const refreshed = await preparePersonalAssistantContext(fixture(), cwd, root, kind, deps, root)
    expect(hookIndex(refreshed)).toContain('renamed-project')
    await (await openingAssistantIndex(root, cwd, kind, deps)).refreshed
    expect(hookIndex(resumed).match(/<gugu_resource_index>/g)).toHaveLength(1)
    expect(next.plugins).not.toEqual(options.plugins)
    expect(start.artifacts!.find(file => file.path.endsWith('/hooks/hooks.json'))?.content).toContain('SessionStart')
    const recovery = start.artifacts!.find(file => file.path.endsWith('/recovery.cjs'))!
    const recovered = await runEventHook(recovery.content, { hook_event_name: 'SessionStart', source: 'resume' })
    expect(recovered.status).toBe(0)
    expect(recovered.stderr).toBe('')
    const recoveryContext = JSON.parse(recovered.stdout).hookSpecificOutput.additionalContext as string
    expect(recoveryContext).toContain(assistantRecoveryContext(assistantHomePaths(root, cwd, kind).memoryDir))
    expect(JSON.parse(recoveryContext.split('\n').find(line => line.startsWith('{'))!)).toMatchObject({
      path: join(assistantHomePaths(root, cwd, kind).memoryDir, 'working-context.md'), status: 'missing',
    })
    // Dynamic account data must not be persisted into a shared instruction file.
    expect(await readFile(assistantHomePaths(root, cwd, kind).instructions, 'utf8')).not.toContain('renamed-project')
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
})

it('uses a native context hook while retaining explicit string and preset system prompts', () => {
  const chosen = fixture()
  const options = (chosen.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
  for (const prompt of ['explicit instructions', { type: 'preset', preset: 'claude_code', append: 'explicit instructions' }]) {
    options.systemPrompt = prompt
    const after = personalAssistantContext(chosen, 'computer', { index: 'fresh-index', guguHome: '/home/gugu' })
    const actual = (after.sessionNewPatch!.meta!.claudeCode as { options: Record<string, unknown> }).options
    expect(actual.systemPrompt).toEqual(prompt)
    expect(hookIndex(after)).toBe('fresh-index')
  }
})

it('delivers a large resource collection as one bounded native hook output with explicit omissions', () => {
  const lines = ['<gugu_resource_index>', JSON.stringify({ account: 'user:owner' }), JSON.stringify({ source: 'projects',
    read: { tool: 'project_list' }, items: Array.from({ length: 180 }, (_, i) => ({
      id: `project:${i}`, name: `项目-${i}-😀`, path: `/Users/owner/projects/${i}`, description: 'x'.repeat(150),
    })) }), '</gugu_resource_index>']
  const index = boundedAssistantIndex(lines)
  const prepared = personalAssistantContext(fixture(), 'computer', { index, guguHome: '/home/gugu' })
  const scripts = prepared.artifacts!.filter(file => /\/startup(?:-\d+)?\.cjs$/.test(file.path))
  expect(scripts).toHaveLength(1)
  expect(hookIndex(prepared)).toBe(index)
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
  expect(hookIndex(prepared)).not.toContain(recoveryContext)
  expect(hookIndex(prepared)).not.toContain('working-context.md')
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
  expect(next.env).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000', KEEP_THIS: 'yes' })
  expect(options.env).toHaveProperty('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', '75')
})

it('refuses to start a strict assistant without its actual Gugu tools', () => {
  const broken = fixture()
  broken.artifacts = []
  expect(() => personalAssistantContext(broken)).toThrow('missing its manifest or MCP config')
  broken.sessionNewPatch = { meta: { claudeCode: { options: {} } } }
  expect(() => personalAssistantContext(broken)).toThrow('no explicit Gugu capabilities')
})

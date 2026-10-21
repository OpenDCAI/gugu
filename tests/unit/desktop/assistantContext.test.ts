import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assistantGuide, assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import { ASSISTANT_TASK_EXECUTION } from '@gugu/core/shared/assistantWorkflow'
import type { Materialization } from '../../../apps/desktop/electron/capability-bundle'
import { personalAssistantContext, refreshAssistantContext } from '../../../apps/desktop/electron/sessionpage/assistant-context'

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
    expect(brief).toContain('新建和复用任务执行者的派活提示词')
    expect(brief).toContain("Don't ask by default")
    expect(brief).toContain('主人明确要求先问后做时照办')
    expect(brief).toContain('删除、停掉、改动主人的任何东西')
    expect(brief).toContain('.gugu-assistant-reference.md')
    expect(brief).not.toContain('"batches"')
    expect(brief.length).toBeLessThan(full.length / 2)
    expect(await readFile(join(cwd, '.gugu-assistant-reference.md'), 'utf8')).toBe(full)
    expect(full).toContain(ASSISTANT_TASK_EXECUTION)
    expect(full).toContain('session_spawn 的 prompt')
    expect(full).toContain('session_message 的 text')
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
    expect(instructions.match(/# 接待与办事/g)).toHaveLength(1)
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
  expect(options.tools).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'])
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

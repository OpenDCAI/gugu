import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import {
  ASSISTANT_COMPUTER_WORKDIR_NAME, assistantBrief, assistantGuide,
  assistantHomePaths, upsertAssistantGuide, withDeniedTools, type AssistantHomeKind,
} from '@gugu/core/shared/assistantPolicy'

const refreshes = new Map<string, Promise<void>>()

/** Role was checked by the caller. Only managed instructions change; memory and custom text stay. */
export async function refreshAssistantContext(cwd: string, guguHome: string, kind: AssistantHomeKind, home = homedir()): Promise<void> {
  if (kind === 'computer' && resolve(cwd) !== resolve(guguHome, ASSISTANT_COMPUTER_WORKDIR_NAME)) return
  const key = assistantHomePaths(home, cwd, kind).instructions
  const previous = refreshes.get(key)
  const gate = Promise.withResolvers<void>()
  refreshes.set(key, gate.promise)
  if (previous) await previous
  try { await writeAssistantContext(cwd, kind, home) }
  finally {
    gate.resolve()
    if (refreshes.get(key) === gate.promise) refreshes.delete(key)
  }
}

async function writeAssistantContext(cwd: string, kind: AssistantHomeKind, home: string) {
  const referenceName = '.gugu-assistant-reference.md'
  const reference = join(cwd, referenceName)
  const full = assistantGuide(kind)
  const paths = assistantHomePaths(home, cwd, kind)
  const brief = assistantBrief(kind, reference, paths.memoryDir)
  const instructions = paths.instructions
  const current = await readFile(instructions, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const settings = kind === 'computer' ? [[paths.settings, await localAssistantSettings(paths.settings, cwd)]] : []
  // Install the complete reference first, so the brief never points to an absent file.
  for (const [path, content] of [[reference, full], [instructions, upsertAssistantGuide(current, brief)], ...settings]) {
    const old = path === instructions ? current : await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (old === content) continue
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  }
}

/** Project-only settings still load ancestor CLAUDE.md files (CLI 2.1.306).
 * Exclude that coding context while retaining this assistant's own instructions. */
async function localAssistantSettings(path: string, cwd: string): Promise<string> {
  const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}'
    throw error
  })
  const settings = JSON.parse(withDeniedTools(raw)) as Record<string, unknown>
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Assistant settings must be an object')
  const existing = settings.claudeMdExcludes ?? []
  if (!Array.isArray(existing) || existing.some(value => typeof value !== 'string')) throw new Error('Assistant instruction exclusions must be strings')
  const excluded: string[] = []
  for (let parent = dirname(resolve(cwd)); ; parent = dirname(parent)) {
    const literal = parent.replaceAll('\\', '/').replace(/[?*[\]{}()!+@]/g, '\\$&')
    const prefix = literal.endsWith('/') ? literal : `${literal}/`
    excluded.push(...['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/AGENTS.md', '.claude/rules/**'].map(name => `${prefix}${name}`))
    if (dirname(parent) === parent) break
  }
  return `${JSON.stringify({ ...settings, claudeMdExcludes: [...new Set([...existing, ...excluded])] }, null, 2)}\n`
}

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { assistantNoteWriteHook } from '../../../apps/desktop/electron/sessionpage/assistant-note-hook'
import { assistantPendingHook } from '../../../apps/desktop/electron/sessionpage/assistant-pending-hook'
import { AssistantWorkStore } from '../../../apps/desktop/electron/sessionpage/assistant-work'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'assistant-note-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function hook(script: string, event: unknown) {
  const inputPath = join(root, '.hook-input.json')
  writeFileSync(inputPath, JSON.stringify(event))
  const fd = openSync(inputPath, 'r')
  let result
  try { result = spawnSync(process.execPath, ['-e', script], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8' }) }
  finally { closeSync(fd); unlinkSync(inputPath) }
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null
}
it.each(['验证码：619284', 'OTP is 619284', 'access_token=abcdefghijklmnopqrstuvwx', 'Bearer abcdefghijklmnopqrstuvwx', 'sk-abcdefghijklmnopqrstuvwxyz1234'])(
  'rejects sensitive values at the native note write boundary (%s)', async content => {
    const file = join(root, 'working-context.md')
    await writeFile(file, 'old constraints')
    expect(hook(assistantNoteWriteHook(root), { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content } }))
      .toMatchObject({ permissionDecision: 'deny' })
    expect(await readFile(file, 'utf8')).toBe('old constraints')
  })
it('checks the complete edited note and preserves ordinary measurements, money and source references', async () => {
  const file = join(root, 'working-context.md')
  await writeFile(file, '验证码：\n等待法务')
  expect(hook(assistantNoteWriteHook(root), { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: '验证码：', new_string: '验证码：619284' } }))
    .toMatchObject({ permissionDecision: 'deny' })
  expect(hook(assistantNoteWriteHook(root), { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {
    file_path: file, content: '预算3200元；步数6840；等待法务，来源gugu-chat://3be752cb-0925-447e-8bbc-70de8a867bd1' } })).toBe(null)
  expect(hook(assistantNoteWriteHook(root), { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(root, 'pending-work.json'), content: '{}' } }))
    .toMatchObject({ permissionDecision: 'deny' })
})
it.each(['startup', 'resume', 'compact', 'clear', 'fork'])('restores pending references on the first %s request without copying private work text', source => {
  const store = new AssistantWorkStore(root)
  const id = store.begin({ kind: 'executor', device: 'phone' }); store.confirm(id, ['session:child'], ['receipt'])
  const output = hook(assistantPendingHook(store.path), { hook_event_name: 'SessionStart', source })
  expect(output.additionalContext).toContain(id)
  expect(output.additionalContext).toContain('session:child')
  expect(output.additionalContext.length).toBeLessThanOrEqual(6_000)
  store.clear()
  expect(hook(assistantPendingHook(store.path), { hook_event_name: 'SessionStart', source })).toBe(null)
})

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assistantHomePaths } from '../../packages/core/src/shared/assistantPolicy'
import type { AssistantPanelChange } from '../../packages/core/src/cloud/assistantPanel'
import { createAssistantPanelApplication, type AssistantPanelHome } from '../../apps/desktop/electron/sessionpage/assistant-panel-application'
import { assistantPanelRevocationHook } from '../../apps/desktop/electron/sessionpage/assistant-panel-hook'

const directories: string[] = []
function runHook(script: string, event: object): Promise<string> {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,['-e',script],{ env: {},stdio: ['pipe','pipe','pipe'],timeout: 5000 })
    let output = '', error = ''
    child.stdout.setEncoding('utf8').on('data',chunk => { output += chunk })
    child.stderr.setEncoding('utf8').on('data',chunk => { error += chunk })
    child.once('error',reject)
    child.once('close',code => code === 0 ? resolve(output) : reject(new Error(error || `Hook exited ${code}`)))
    child.stdin.end(JSON.stringify(event))
  })
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path,{ recursive: true,force: true }))) })
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(),'gugu-panel-application-')))
  directories.push(home)
  const binding: AssistantPanelHome = { ownerId: 'owner',assistantId: 'assistant',home,cwd: join(home,'assistant'),kind: 'computer' }
  await mkdir(binding.cwd)
  const paths = assistantHomePaths(home,binding.cwd,'computer')
  const deps = { assertCurrent: vi.fn(async () => {}),readBody: vi.fn(async () => new TextEncoder().encode('A remembered fact.')),
    applyService: vi.fn(async () => {}),invalidate: vi.fn(async () => {}) }
  const application = createAssistantPanelApplication(binding,deps)
  return { application,binding,paths,deps }
}
const change = (operation: 'save' | 'remove', domain = 'memory', data: Record<string, unknown> = { relativePath: 'note.md' }): AssistantPanelChange => ({
  operation_id: `${operation}-${domain}`,revision: '1',assistant_user_id: 'assistant',owner_user_id: 'owner',domain,resource_key: 'note',
  device_id: 'home',operation,payload: { [operation === 'remove' ? 'before' : 'data']: data },status: 'pending',error_code: null,
})

describe('assistant panel local effects', () => {
  it('deletes the original and all index references, persists revocation, and appends the notice before a model request', async () => {
    const { application,paths,deps } = await fixture()
    await application.apply(change('save'))
    const note = join(paths.memoryDir,'note.md')
    expect(await readFile(note,'utf8')).toBe('A remembered fact.')
    await (await application.prepareText('first turn')).accepted()
    await writeFile(paths.memoryIndex,`[one](note.md)\n[two](./note.md)\n[encoded](note%2Emd)\n[absolute](${note})\n[other](other.md)\n`)
    await application.apply(change('remove'))
    await expect(readFile(note)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(paths.memoryIndex,'utf8')).toBe('[other](other.md)\n')
    const prepared = await application.prepareText('next request')
    expect(prepared.text).toContain('这条记忆已被主人删除，不再作为依据')
    expect(prepared.text).not.toContain('A remembered fact.')
    expect(prepared.text).toContain('next request')
    expect(deps.invalidate).toHaveBeenCalledTimes(2)
    // Run the generated command hook itself after the file has been removed.
    const script = assistantPanelRevocationHook(application.statePath)
    for (const tool of ['Read','Write','Edit']) {
      const output = await runHook(script,{ hook_event_name: 'PreToolUse',tool_name: tool,tool_input: { file_path: note } })
      expect(JSON.parse(output).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny',permissionDecisionReason: expect.stringContaining('已被主人删除') })
    }
    await prepared.accepted()
    expect((await application.prepareText('later')).text).toBe('later')
    await expect(application.apply(change('save'))).rejects.toThrow('RESOURCE_DELETED')
  })

  it('writes personality changes while preserving the current managed instructions', async () => {
    const { application,paths } = await fixture()
    await writeFile(paths.instructions,'<!-- 咕咕管家 -->\ncurrent policy\n<!-- /咕咕管家 -->\n\nold personality\n')
    await application.apply(change('save','personality',{ text: 'Use a concise tone.' }))
    const saved = await readFile(paths.instructions,'utf8')
    expect(saved).toContain('current policy')
    expect(saved).toContain('Use a concise tone.')
    expect(saved).not.toContain('old personality')
    expect((await application.prepareText('answer')).text).toContain('Use a concise tone.')
  })

  it('retains pending notices until an actual receipt and preserves notices added in the meantime', async () => {
    const { application } = await fixture()
    await application.apply(change('save'))
    const first = await application.prepareText('first')
    await application.apply({ ...change('save','personality',{ text: 'New agreement.' }),operation_id: 'new-personality' })
    await first.accepted()
    const remaining = await application.prepareText('second')
    expect(remaining.text).toContain('New agreement.')
    expect(remaining.text).not.toContain('save-memory')
  })

  it('refuses another account before effects and treats an unreadable ledger as a failure', async () => {
    const { application,deps } = await fixture()
    await expect(application.apply({ ...change('save'),owner_user_id: 'other' })).rejects.toThrow('PANEL_ACCOUNT_CHANGED')
    expect(deps.readBody).not.toHaveBeenCalled()
    await application.apply(change('save'))
    await writeFile(application.statePath,'{invalid')
    await expect(application.prepareText('next')).rejects.toThrow()
    expect(deps.readBody).toHaveBeenCalledTimes(1)
  })
})

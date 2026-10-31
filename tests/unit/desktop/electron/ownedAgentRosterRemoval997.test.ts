import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

// Importing the Electron entrypoint boots the app. Execute its actual callback body,
// with only host services replaced; a duplicate implementation cannot protect main.ts.
const file = 'apps/desktop/electron/main.ts'
const text = readFileSync(resolve(file), 'utf8')
const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
const callback = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'onLocalAgentRosterRemoved')
if (!callback) throw new Error(`${file}: missing onLocalAgentRosterRemoved`)
const code = ts.transpileModule(`${callback.getText(source)}\nglobalThis.callback = onLocalAgentRosterRemoved`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function host() {
  const unregister = vi.fn(async (_id: string) => {})
  const revoke = vi.fn(async (_id: string) => {})
  const removeTask = vi.fn(async (_id: string) => {})
  const dispose = vi.fn(async (_agent: unknown) => {})
  const context = {
    cacheString: (cache: Record<string, unknown> | null, key: string) => typeof cache?.[key] === 'string' ? cache[key] : '',
    SESSION_CACHE_KEY: 'emdash_session_id', PARKED_SESSION_CACHE_KEY: 'sessionpage_parked_session_id',
    unregisterSessionpageDeliveryOwners: unregister, revokeAgentCards: revoke,
    removeDeletedAgentTask: removeTask, disposeSessionpageAgentFromRoster: dispose,
    callback: undefined as undefined | ((agent: { gugu_user_id: string | null; cache?: Record<string, unknown> }, reason: string) => Promise<void>),
  }
  runInNewContext(code, context, { filename: file })
  return { run: context.callback!, unregister, revoke, removeTask, dispose }
}

describe('main host requires confirmed deletion before removing a task (#997)', () => {
  it.each(['emdash_session_id', 'sessionpage_parked_session_id'])('cloud-gone only revokes routing/cards for a %s binding', async key => {
    const h = host()
    // Owner-less legacy rows may be unwritable after an account switch.
    await h.run({ gugu_user_id: 'legacy-agent', cache: { [key]: 'other-account-task' } }, 'cloud-gone')
    expect(h.unregister).toHaveBeenCalledExactlyOnceWith('legacy-agent')
    expect(h.revoke).toHaveBeenCalledExactlyOnceWith('legacy-agent')
    expect(h.removeTask).not.toHaveBeenCalled()
    expect(h.dispose).not.toHaveBeenCalled()
  })

  it.each(['emdash_session_id', 'sessionpage_parked_session_id'])('cloud-removed deletes the confirmed %s task', async key => {
    const h = host()
    await h.run({ gugu_user_id: 'removed-agent', cache: { [key]: 'confirmed-task' } }, 'cloud-removed')
    expect(h.removeTask).toHaveBeenCalledExactlyOnceWith('confirmed-task')
    expect(h.revoke).toHaveBeenCalledExactlyOnceWith('removed-agent')
    expect(h.dispose).not.toHaveBeenCalled()
  })

  it('owner change retains the existing disposal path without permanent deletion', async () => {
    const h = host()
    const agent = { gugu_user_id: 'unknown-owner', cache: { emdash_session_id: 'retained-task' } }
    await h.run(agent, 'owner-change')
    expect(h.dispose).toHaveBeenCalledExactlyOnceWith(agent)
    expect(h.removeTask).not.toHaveBeenCalled()
  })
})

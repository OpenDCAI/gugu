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
  const archive = vi.fn(async (..._args: unknown[]) => {})
  const facts = vi.fn(async () => [{ sessionId: 'confirmed-task', projectId: 'project' }])
  const dispose = vi.fn(async (_agent: unknown) => {})
  const context = {
    cacheString: (cache: Record<string, unknown> | null, key: string) => typeof cache?.[key] === 'string' ? cache[key] : '',
    SESSION_CACHE_KEY: 'emdash_session_id', PARKED_SESSION_CACHE_KEY: 'sessionpage_parked_session_id',
    unregisterSessionpageDeliveryOwners: unregister, revokeAgentCards: revoke,
    loadEmdashBridge: () => ({ archiveSession: archive, emdashSessionpageSessionFacts: facts }),
    disposeSessionpageAgentFromRoster: dispose,
    callback: undefined as undefined | ((agent: { gugu_user_id: string | null; cache?: Record<string, unknown> }, reason: string, receipt?: { userId: string; removedAt: string }) => Promise<void>),
  }
  runInNewContext(code, context, { filename: file })
  return { run: context.callback!, unregister, revoke, archive, facts, dispose }
}

describe('main host archives the same task from a confirmed cloud receipt', () => {
  it.each(['emdash_session_id', 'sessionpage_parked_session_id'])('cloud-gone only revokes routing/cards for a %s binding', async key => {
    const h = host()
    // Owner-less legacy rows may be unwritable after an account switch.
    await h.run({ gugu_user_id: 'legacy-agent', cache: { [key]: 'other-account-task' } }, 'cloud-gone')
    expect(h.unregister).toHaveBeenCalledExactlyOnceWith('legacy-agent')
    expect(h.revoke).toHaveBeenCalledExactlyOnceWith('legacy-agent')
    expect(h.archive).not.toHaveBeenCalled()
    expect(h.dispose).not.toHaveBeenCalled()
  })

  it.each(['emdash_session_id', 'sessionpage_parked_session_id'])('cloud-removed archives the confirmed %s task with its original receipt', async key => {
    const h = host()
    const receipt = { userId: 'removed-agent', removedAt: '2026-10-31T03:00:00Z' }
    await h.run({ gugu_user_id: 'removed-agent', cache: { [key]: 'confirmed-task' } }, 'cloud-removed', receipt)
    expect(h.archive).toHaveBeenCalledExactlyOnceWith('project', 'confirmed-task', { removeSocialIdentity: true }, receipt)
    expect(h.revoke).toHaveBeenCalledExactlyOnceWith('removed-agent')
    expect(h.dispose).not.toHaveBeenCalled()
  })

  it('rejects a mismatched or missing receipt before changing routing', async () => {
    const h = host()
    for (const receipt of [undefined, { userId: 'different-agent', removedAt: '2026-10-31T03:00:00Z' }]) {
      await expect(h.run({ gugu_user_id: 'removed-agent', cache: { emdash_session_id: 'confirmed-task' } }, 'cloud-removed', receipt)).rejects.toThrow('does not match')
    }
    expect(h.archive).not.toHaveBeenCalled()
    expect(h.unregister).not.toHaveBeenCalled()
  })

  it('propagates archive failure to the roster owner instead of claiming cleanup succeeded', async () => {
    const h = host()
    h.archive.mockRejectedValueOnce(new Error('archive disk unavailable'))
    await expect(h.run({ gugu_user_id: 'removed-agent', cache: { emdash_session_id: 'confirmed-task' } }, 'cloud-removed',
      { userId: 'removed-agent', removedAt: '2026-10-31T03:00:00Z' })).rejects.toThrow('archive disk unavailable')
  })

  it('owner change retains the existing disposal path without permanent deletion', async () => {
    const h = host()
    const agent = { gugu_user_id: 'unknown-owner', cache: { emdash_session_id: 'retained-task' } }
    await h.run(agent, 'owner-change')
    expect(h.dispose).toHaveBeenCalledExactlyOnceWith(agent)
    expect(h.archive).not.toHaveBeenCalled()
  })
})

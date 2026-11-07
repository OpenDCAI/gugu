// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMobileListDiagnostics, type ListRowFacts, type ShellListState } from '../../../apps/desktop/src/mobile/mobileListDiagnostics'
import { readMobileListGeometry } from '../../../apps/desktop/src/mobile/useMobileListDiagnostics'

beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const pixels = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value)
const flag = (value: unknown) => typeof value === 'boolean'
const code = (...values: string[]) => (value: unknown) => typeof value === 'string' && values.includes(value)
const digest = (value: unknown) => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

// Independent, explicit privacy contract. Do not derive allowed keys from runtime types or output.
const leaves: Record<string, (value: unknown) => boolean> = {
  version: value => value === 1, suppressed: count,
  'entries[].sequence': count, 'entries[].at': count, 'entries[].suppressed': count,
  'entries[].event': code('shell', 'rows', 'row-open'),
  'entries[].reason': code('commit', 'viewport', 'visibility'),
  'entries[].state.activeTab': code('chats', 'contacts', 'tasks', 'assistant', 'settings', 'unknown'),
  'entries[].state.pagerTab': code('chats', 'contacts', 'tasks', 'assistant', 'settings', 'unknown'),
  'entries[].state.mobilePane': code('list', 'chat'),
  'entries[].state.phoneLayerOpen': flag, 'entries[].state.chatListHidden': flag, 'entries[].state.tabBarVisible': flag,
  'entries[].geometry.online': flag, 'entries[].geometry.foreground': flag,
  'entries[].geometry.viewport[]': count,
  'entries[].geometry.scrollLeft': value => value === null || pixels(value),
  'entries[].geometry.scrollWidth': value => value === null || count(value),
  'entries[].sourceCount': count, 'entries[].renderedCount': count, 'entries[].loading': flag, 'entries[].changedCount': count,
  'entries[].changes[].row': digest, 'entries[].changes[].change': code('added', 'changed', 'removed'),
  'entries[].changes[].kind': code('dm', 'ai', 'group', 'topic', 'unknown'),
  'entries[].changes[].listed': flag, 'entries[].changes[].rendered': flag, 'entries[].changes[].searchMatch': flag,
  'entries[].changes[].owned': flag, 'entries[].changes[].imActivity': flag, 'entries[].changes[].projectedActivity': flag,
  'entries[].changes[].selected': flag, 'entries[].changes[].draft': flag,
  'entries[].row': digest,
}
for (const node of ['shell', 'pager', 'listPane', 'list', 'me']) {
  const path = `entries[].geometry.${node}`
  leaves[path] = value => value === null
  for (const field of ['x', 'y', 'width', 'height']) leaves[`${path}.${field}`] = pixels
  leaves[`${path}.display`] = code('none', 'contents', 'box')
  leaves[`${path}.visibility`] = code('visible', 'hidden', 'collapse')
  leaves[`${path}.contentVisibility`] = code('visible', 'hidden', 'auto')
  leaves[`${path}.inert`] = flag
}
const prefixes = new Set([''])
for (const leaf of Object.keys(leaves)) {
  const parts = leaf.split('.')
  for (let n = 1; n <= parts.length; n++) {
    const prefix = parts.slice(0, n).join('.')
    prefixes.add(prefix)
    if (prefix.endsWith('[]')) prefixes.add(prefix.slice(0, -2))
  }
}
const arrays = new Set(['entries', 'entries[].changes', 'entries[].geometry.viewport'])
function assertAllowed(value: unknown, path = ''): void {
  expect(prefixes.has(path), `unapproved diagnostic field ${path}`).toBe(true)
  if (Array.isArray(value)) {
    expect(arrays.has(path), `unapproved array ${path}`).toBe(true)
    for (const item of value) assertAllowed(item, `${path}[]`)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertAllowed(child, path ? `${path}.${key}` : key)
  } else {
    expect(leaves[path]?.(value) ?? false, `unapproved leaf ${path}`).toBe(true)
  }
}

it('locks every exported JSON leaf to the reviewed field and fixed-code whitelist, including hostile errors', async () => {
  const fakeError = new Error('qa-private@example.invalid 的中文机密会话标题')
  const output: unknown[] = []
  const record = createMobileListDiagnostics(entry => { output.push(entry); throw fakeError })
  const state: ShellListState = { activeTab: 'chats', pagerTab: 'chats', mobilePane: 'list', phoneLayerOpen: false, chatListHidden: false, tabBarVisible: true }
  document.body.innerHTML = '<main><div data-mobile-tab-pager><div data-testid="chat-list-pane"><nav data-phone-root-list="chats"><button data-testid="mobile-profile-nav">中文机密会话标题</button></nav></div></div></main>'
  const root = document.querySelector('main')!
  await record.shell('commit', state, readMobileListGeometry(root))
  const facts: ListRowFacts = { kind: 'dm', listed: true, rendered: true, searchMatch: true, owned: true,
    imActivity: false, projectedActivity: true, selected: false, draft: false }
  await record.rows([{ id: 'private-chat-id', facts: { ...facts, error: fakeError } as ListRowFacts }], true)
  await record.rows([{ id: 'private-chat-id', facts: { ...facts, listed: false, rendered: false } }], false)
  await record.rows([], false)
  await record.openRow('private-chat-id')
  vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(fakeError)
  await record.openRow('hash-failure-id')
  root.replaceChildren()
  await record.shell('visibility', state, readMobileListGeometry(root))

  const serialized = JSON.stringify(record.recent())
  assertAllowed(JSON.parse(serialized))
  assertAllowed({ version: 1, entries: output, suppressed: 0 })
  expect(serialized).not.toMatch(/qa-private|example\.invalid|中文机密会话标题|private-chat-id|hash-failure-id|Error|message|stack/)
  // Prove the guard also rejects unknown empty containers and arbitrary text, not just today's output.
  expect(() => assertAllowed({ version: 1, entries: [], suppressed: 0, futureText: {} })).toThrow()
  expect(() => assertAllowed({ version: 1, entries: [{ event: '中文机密会话标题' }], suppressed: 0 })).toThrow()
})

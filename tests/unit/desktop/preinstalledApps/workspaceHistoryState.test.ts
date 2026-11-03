// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, expect, it, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const entry = { id: 'readme', chat: 'chat', name: 'README.md', displayName: 'README.md', type: 'text', contentType: 'text/markdown', parentId: null, path: 'README.md', systemRole: null, version: 1, createdAt: '2026-11-03T08:00:00Z', updatedAt: null, sourceMessageIds: [], size: 1 }
const context = { tabId: 'one-context', chat: { id: 'chat', kind: 'group', name: 'Files', groupId: null }, locale: 'en-US', capabilities: ['files:read', 'files:write'] }
let changed: (ctx: Record<string, unknown>) => Promise<void>
const gugu = {
  linkTo: async () => 'gugu-file://readme', getContext: async () => context,
  setTabTitle: vi.fn(async () => {}), onContextChanged: (fn: typeof changed) => { changed = fn; return () => {} },
  onLink: () => () => {}, showContextMenu: vi.fn(async () => null), navigation: { go: vi.fn(async () => false) },
  files: { list: vi.fn(async () => [entry]), viewPreferences: async () => ({ showAppData: false }), onChanged: () => () => {}, openWith: vi.fn(async () => {}), open: vi.fn(async () => ({ type: 'binary', entry, close() {} })) },
}
beforeAll(async () => {
  document.body.innerHTML = new DOMParser().parseFromString(readFileSync(resolve('apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8'), 'text/html').body.innerHTML
  Object.assign(globalThis, { gugu, CSS: { escape: (v: string) => v } }); Object.assign(window, { gugu })
  // @ts-expect-error The bundled App is JavaScript.
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the actual App lists its file', () => !!document.querySelector('.file-open'))
})
it('restores list scroll, filter and selection from the page history after viewing a file', async () => {
  await changed({ ...context, file: { chat: 'chat', id: 'readme' } })
  await changed({ ...context, viewState: { root: 'chat', folder: null, filter: 'README', kind: 'all', sort: 'recent', picked: ['readme'], selecting: true, pickFrom: 'readme', scrollTop: 123 } })
  expect((document.getElementById('filter') as HTMLInputElement).value).toBe('README')
  expect(document.getElementById('file-list')!.scrollTop).toBe(123)
  expect(document.querySelector('[data-id="readme"]')?.classList.contains('picked')).toBe(true)
})

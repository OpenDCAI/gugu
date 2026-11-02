// @vitest-environment node
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { injectAppRuntime } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

let script: string
const pages: JSDOM[] = []
const member = { id: 'user:reader', name: 'Reader', kind: 'human', avatar: 'data:image/png;base64,YQ==' }
beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../../../../apps/desktop/src/session/app-runtime/ui/ui-entry.ts', import.meta.url))],
    bundle: true, write: false, format: 'iife', platform: 'browser',
    alias: { '@gugu/session-ui/icon-bodies': fileURLToPath(new URL('../../../../packages/session-ui/src/icon-bodies.ts', import.meta.url)) },
  })
  script = result.outputFiles[0]!.text
})
afterEach(() => { for (const page of pages.splice(0)) page.window.close() })

function page(apiVersion: number, avatarsHtml = '<gugu-avatar user="user:reader" name></gugu-avatar><gugu-avatar user="user:reader" name></gugu-avatar>') {
  const dom = new JSDOM(injectAppRuntime('<!doctype html><body></body>', apiVersion), { runScripts: 'outside-only' })
  pages.push(dom)
  const calls: string[] = []
  let push: ((context: unknown) => void) | undefined
  const context = { apiVersion: 99, locale: 'en', themeMode: 'light', chat: { id: 'chat', name: 'Group', kind: 'group', ...(apiVersion <= 25 ? { members: [member] } : {}) } }
  Object.assign(dom.window, {
    CSSStyleSheet: class { replaceSync() {} },
    gugu: {
      apiVersion: 99,
      getContext: async () => context,
      onContextChanged: (handler: typeof push) => { push = handler },
      chats: { members: async ({ chat }: { chat: string }) => { calls.push(chat); return { members: [member] } } },
    },
  })
  dom.window.eval(script)
  dom.window.document.body.innerHTML = avatarsHtml
  const avatars = () => [...dom.window.document.querySelectorAll('gugu-avatar')]
  return { calls, avatars, push: () => push?.({ ...context, themeMode: 'dark' }) }
}

describe('avatar members use the page\'s declared API, independently of the host API', () => {
  it('an API 26 label without a user needs no members', async () => {
    const modern = page(26, '<gugu-avatar label="Guest" name></gugu-avatar>')
    const avatar = modern.avatars()[0] as Element & { draw(): Promise<void> }
    await avatar.draw()
    expect(avatar.shadowRoot?.querySelector('[part="name"]')?.textContent).toBe('Guest')
    expect(modern.calls).toEqual([])
  })

  it('API 25 and API 26 pages side by side draw names and faces; only the newer page requests members, once', async () => {
    const legacy = page(25)
    const modern = page(26)
    const avatars = [...legacy.avatars(), ...modern.avatars()] as (Element & { draw(): Promise<void> })[]
    await Promise.all(avatars.map((avatar) => avatar.draw()))
    for (const avatar of avatars) {
      expect(avatar.shadowRoot?.querySelector('[part="name"]')?.textContent).toBe('Reader')
      expect(avatar.shadowRoot?.querySelector('img')?.getAttribute('src')).toBe(member.avatar)
    }
    expect(legacy.calls).toEqual([])
    expect(modern.calls).toEqual(['chat'])
    modern.push()
    for (const avatar of modern.avatars()) await (avatar as Element & { draw(): Promise<void> }).draw()
    expect(modern.calls).toEqual(['chat'])
  })
})

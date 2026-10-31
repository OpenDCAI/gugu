// @vitest-environment jsdom
import { act, createElement, Fragment, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '../../../../apps/desktop/src/components/markdown/Markdown'
import { openLink, openLinkTarget } from '../../../../apps/desktop/src/lib/guguLinks'
import { classifyFileLink, type GuguLinkTarget } from '@gugu/core/shared/ui/guguLink'
import { openLinkWith } from '../../../../apps/desktop/src/session/shared/extensions/open-link'
import { useLinkNavigation } from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { installedExtensionsStore } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { runInAction } from 'mobx'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The files this person can read, and the chat each is in (F112): answered where the chat client's read of
 * `workspace_items` leaves the page, the way the database answers under RLS — no row for a file of a chat they are not in.
 */
const notice = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/lib/notices', async (original) => ({ ...await original<object>(), notify: notice }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'web' } }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessageById: vi.fn() } }))
vi.mock('../../../../apps/desktop/src/components/appSlot/phoneAppHost', () => ({
  openPhoneLink: (target: GuguLinkTarget) => openLinkWith({
    installed: () => [], isEnabled: () => false, locale: () => 'en', sessionProject: async () => null, agentSession: async () => null,
    reveal: async () => {}, openApp: async () => 'own', resourceChat: async (id) => id,
    openResource: async (resource) => { await openLinkTarget(resource) }, bringUp: async () => {}, deliver: () => {},
  }, target),
}))
const readable = new Map<string, string>()
const asked: unknown[] = []
const noop = () => undefined
function Shell() {
  useLinkNavigation({ ownerId: 'owner', chats: [...new Set(readable.values())].map((id) => ({ id, kind: 'group' })) as never, contacts: [],
    openChat: noop, openFile: (chatId, target) => asked.push({ chatId, ...target }), openApp: noop, openOwnApp: noop, openProject: noop, openAssistant: noop })
  return null
}
function Document(props: ComponentProps<typeof Markdown>) { return createElement(Fragment, null, createElement(Shell), createElement(Markdown, props)) }
beforeEach(() => {
  readable.clear(); asked.length = 0; notice.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const id = url.searchParams.get('id')?.replace(/^eq\./, '') ?? ''
    const rows = url.pathname.endsWith('/workspace_items') && readable.has(id) ? [{ chat_id: readable.get(id) }] : []
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function renderMarkdown(onOpenLocalFileLink: (path: string) => void): Promise<void> {
  await act(async () => {
    root.render(createElement(Document, {
      trust: 'chat',
      content: '[local](</Users/example/Application Support/task-home/notes.md>) [web](https://example.com/docs)',
      onOpenLink: (href) => { const file = classifyFileLink(href); if (file.kind !== 'workspace-file') return false; onOpenLocalFileLink(file.path); return true },
    }))
    await Promise.resolve()
  })
}
describe('Markdown local file links in chat', () => {
  it('hands decoded local paths to the caller without intercepting external URLs', async () => {
    const onOpenLocalFileLink = vi.fn()
    await renderMarkdown(onOpenLocalFileLink)
    const links = container.querySelectorAll<HTMLAnchorElement>('a')
    expect(links).toHaveLength(2)
    const localClick = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => links[0]!.dispatchEvent(localClick))
    expect(localClick.defaultPrevented).toBe(true)
    expect(onOpenLocalFileLink).toHaveBeenCalledWith(
      '/Users/example/Application Support/task-home/notes.md',
    )
    const externalClick = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => links[1]!.dispatchEvent(externalClick))
    expect(externalClick.defaultPrevented).toBe(false)
    expect(onOpenLocalFileLink).toHaveBeenCalledTimes(1)
  })

  it('sends a link no caller claimed to the system browser only when it is a web link', async () => {
    await act(async () => {
      root.render(createElement(Document, {
        trust: 'chat',
        content: '[drive](C:\\Users\\me\\run.bat) [relative](notes/a.md) [web](https://example.com)',
      }))
      await Promise.resolve()
    })
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'))
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['C:%5CUsers%5Cme%5Crun.bat', 'notes/a.md', 'https://example.com'])
    const prevented: boolean[] = []
    for (const link of links) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      await act(async () => link.dispatchEvent(click))
      prevented.push(click.defaultPrevented)
    }
    expect(prevented).toEqual([true, true, false])
  })

  it('keeps raw HTML and images literal in chat, so rendering makes no request (#1536/#1734)', async () => {
    await act(async () => {
      root.render(createElement(Document, {
        trust: 'chat',
        content: 'hi <img src="https://tracker.example/p.png"> ![pic](https://tracker.example/q.png) <b>bold</b>',
      }))
      await Promise.resolve()
    })
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<img src="https://tracker.example/p.png">')
    expect(container.textContent).toContain('![pic](https://tracker.example/q.png)')
  })

  // 摩擦单 F10: before, the sanitizer dropped the `gugu-file:` href — the link rendered, and a click did nothing.
  // F112: the link names only the file; the chat it opens in is the one the file is in.
  it('keeps resource hrefs and opens the file in its readable chat; an inaccessible file reports the refusal', async () => {
    const chatId = '44444444-4444-4444-8444-444444444444'
    const itemId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const elsewhere = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    readable.set(itemId, chatId)
    await act(async () => root.render(createElement(Document, { trust: 'chat', content: `[plan.md](gugu-file://${itemId}) [local](notes/a.md) [theirs](gugu-file://${elsewhere})` })))
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a')]
    expect(links.map((anchor) => anchor.getAttribute('href'))).toEqual([`gugu-file://${itemId}`, 'notes/a.md', `gugu-file://${elsewhere}`])
    const click = async (anchor: HTMLAnchorElement) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      await act(async () => { anchor.dispatchEvent(event); await vi.dynamicImportSettled() })
      return event.defaultPrevented
    }
    expect(await click(links[0]!)).toBe(true)
    await vi.waitFor(() => expect(asked).toEqual([{ chatId, kind: 'file', itemId }]))
    expect(await click(links[1]!)).toBe(true)
    expect(await click(links[2]!)).toBe(true)
    await vi.waitFor(() => expect(notice).toHaveBeenCalledWith(expect.objectContaining({ tier: 'error' })))
    expect(asked).toEqual([{ chatId, kind: 'file', itemId }])
  })

  // 摩擦单 F39: before, a link written as the file's name (the MCP's, gugu.send's `about`) showed the claim suffix the
  // file list hides — `guess.draw-guess.json` in the chat, `guess` in the list.
  it('reads a group file link written as its name the way the file list does, by the Apps here; the link and other words stay', async () => {
    const link = 'gugu-file://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const drawGuess = parseExtensionManifest({
      id: 'draw-guess',
      name: '你画我猜',
      version: '1.0.0',
      apiVersion: EXTENSION_API_VERSION,
      entry: 'index.html',
      contributes: { tabs: [{ name: 'main', title: '你画我猜', opensFiles: { chat: ['.draw-guess.json'] } }] },
    })
    const content = `[guess.draw-guess.json](${link}) [看这局](${link}) [guess.draw-guess.json](https://example.com/guess.draw-guess.json)`
    const shown = () => Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).map((a) => [a.textContent, a.querySelector('[title]')?.getAttribute('title') ?? null, a.getAttribute('href')])
    try {
      // Nobody here claims it: the name as written — the control for the claimed case below.
      await act(async () => {
        root.render(createElement(Document, { trust: 'chat', content, onOpenLink: undefined }))
        await Promise.resolve()
      })
      expect(shown()).toEqual([
        ['guess.draw-guess.json', null, link],
        ['看这局', null, link],
        ['guess.draw-guess.json', null, 'https://example.com/guess.draw-guess.json'],
      ])
      // Installed here: the list's name, the whole one on hover; the words that are no file name and a web link stay.
      await act(async () => {
        runInAction(() => {
          installedExtensionsStore.manifests = [drawGuess]
          installedExtensionsStore.disabled = []
        })
        await Promise.resolve()
      })
      expect(shown()).toEqual([
        ['guess', 'guess.draw-guess.json', link],
        ['看这局', null, link],
        ['guess.draw-guess.json', null, 'https://example.com/guess.draw-guess.json'],
      ])
      // Switched off here: it reads as written again.
      await act(async () => {
        runInAction(() => {
          installedExtensionsStore.disabled = ['draw-guess']
        })
        await Promise.resolve()
      })
      expect(shown()[0]).toEqual(['guess.draw-guess.json', null, link])
    } finally {
      runInAction(() => {
        installedExtensionsStore.manifests = []
        installedExtensionsStore.disabled = []
      })
    }
  })

  it('returns whether the shell opened the resolved resource, or why no shell received it', async () => {
    const itemId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const link = `gugu-file://${itemId}`
    readable.set(itemId, '44444444-4444-4444-8444-444444444444')
    expect(openLink('https://example.com')).toBeNull()
    await expect(openLink(link)).rejects.toThrow('shell is not ready')
    await act(async () => root.render(createElement(Document, { trust: 'chat', content: '' })))
    await expect(openLink(link)).resolves.toBe(true)
    expect(asked).toEqual([{ chatId: '44444444-4444-4444-8444-444444444444', kind: 'file', itemId }])
  })
})

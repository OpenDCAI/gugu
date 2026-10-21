// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '../../../../apps/desktop/src/components/markdown/Markdown'
import { chatLinks, openGroupFileLink } from '../../../../apps/desktop/src/components/markdown/fileLinks'
import { GROUP_FILE_OPEN_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { installedExtensionsStore } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { runInAction } from 'mobx'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The files this person can read, and the chat each is in (F112): answered where the chat client's read of
 * `workspace_items` leaves the page, the way the database answers under RLS — no row for a file of a chat they are not in.
 */
const readable = new Map<string, string>()
beforeEach(() => {
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
    root.render(createElement(Markdown, {
      trust: 'chat',
      content: '[local](</Users/example/Application Support/task-home/notes.md>) [web](https://example.com/docs)',
      onOpenLink: chatLinks(onOpenLocalFileLink),
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
      root.render(createElement(Markdown, {
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
      root.render(createElement(Markdown, {
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
  it('keeps a group file link and opens it in the group the file is in, whoever wrote the message; a person’s local path stays unclaimed', async () => {
    const chatId = '44444444-4444-4444-8444-444444444444'
    const itemId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const elsewhere = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    readable.set(itemId, chatId)
    const asked: unknown[] = []
    const onAsk = (event: Event) => asked.push((event as CustomEvent).detail)
    window.addEventListener(GROUP_FILE_OPEN_EVENT, onAsk)
    /** A click, and its open run to the end: the chat client loads when a link opens, then the file is read. */
    const click = async (link: HTMLAnchorElement) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      await act(async () => {
        link.dispatchEvent(event)
        await vi.dynamicImportSettled()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      return event.defaultPrevented
    }
    try {
      // A person's message (no local-file opener): the group file link still opens; the local path is not handed on.
      await act(async () => {
        root.render(createElement(Markdown, {
          trust: 'chat',
          content: `[plan.md](gugu-file://${itemId}) [local](notes/a.md) [theirs](gugu-file://${elsewhere})`,
          onOpenLink: chatLinks(undefined),
        }))
        await Promise.resolve()
      })
      const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'))
      expect(links.map((a) => a.getAttribute('href'))).toEqual([`gugu-file://${itemId}`, 'notes/a.md', `gugu-file://${elsewhere}`])
      expect(await click(links[0]!)).toBe(true)
      expect(asked).toEqual([{ chatId, itemId }])
      expect(await click(links[1]!)).toBe(true)
      expect(asked).toHaveLength(1)
      // Control: a file of a chat the person is not in reads as none — the chat shell hears no chat (and says so).
      expect(await click(links[2]!)).toBe(true)
      expect(asked).toEqual([{ chatId, itemId }, { chatId: null, itemId: elsewhere }])
    } finally {
      window.removeEventListener(GROUP_FILE_OPEN_EVENT, onAsk)
      readable.clear()
    }
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
        root.render(createElement(Markdown, { trust: 'chat', content, onOpenLink: chatLinks(undefined) }))
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

  it('session_open_in_tab hears whether the file was opened: taken by the chat shell, or not (not in that chat)', async () => {
    const link = 'gugu-file://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    readable.set('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '44444444-4444-4444-8444-444444444444')
    expect(openGroupFileLink('https://example.com')).toBeNull()
    // No chat shell took it (the person is not in that chat): not opened — control for the taken case below.
    await expect(openGroupFileLink(link)).resolves.toBe(false)
    const take = (event: Event) => event.preventDefault()
    window.addEventListener(GROUP_FILE_OPEN_EVENT, take)
    try {
      await expect(openGroupFileLink(link)).resolves.toBe(true)
    } finally {
      window.removeEventListener(GROUP_FILE_OPEN_EVENT, take)
      readable.clear()
    }
  })
})

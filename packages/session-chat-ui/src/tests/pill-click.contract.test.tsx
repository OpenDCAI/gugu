/** @jsxImportSource solid-js */
/**
 * App 引用 pill (148 17:03): a file pill in the transcript is read the way a link is. One pointing at a group's file
 * (`gugu-file://<id>?v=…#<at>`) opens there with its place, through the same `classifyLink` → `onOpenGroupFile` a link
 * takes; a pill naming a path on this computer still goes to the host as a file mention. Clicked for real, on the
 * product's own parse → html block → click chain (link-sim.contract.test.tsx's mount, copied: it is private there).
 */
import { describe, expect, it } from 'vitest'
import { parseMarkdownToBlocks } from '../core/markdown/parse'
import { classifyFileLink } from '@gugu/core/shared/ui/fileLink'
import { stringifyMention } from '@gugu/session-shared/markdown'
import { htmlBlockDef } from '@session-chat/components/rows/markdown/html/html.def'
import { makeContractCtx } from './contract'
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext'
import { CachesContext } from '@session-chat/components/contexts/CachesContext'
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext'
import type { ChatCommands } from '@session-chat/commands'
import type { HtmlBlock } from '@session-chat/core/markdown/document'
import type { MentionProvider } from '@session-chat/core/markdown/mention-provider'
import { render } from 'solid-js/web'
import type { JSX } from 'solid-js'

const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CTX = makeContractCtx({ width: 640 })
// What the session page's provider says of these targets: files (a `gugu-file://` link contains `/`).
const files: MentionProvider = { resolve: (token) => ({ id: token, label: token, kind: 'file' }) }

async function clickChips(markdown: string, commands: ChatCommands): Promise<number> {
  const block = parseMarkdownToBlocks('pill', markdown, files).find((b): b is HtmlBlock => b.kind === 'html')!
  const measured = htmlBlockDef.measure(block, CTX)
  const host = document.createElement('div')
  host.style.width = '640px'
  document.body.appendChild(host)
  const Comp = htmlBlockDef.Render as (props: { node: typeof measured }) => JSX.Element
  const dispose = render(
    () => (
      <ThemeContext.Provider value={() => CTX.theme}>
        <CachesContext.Provider value={CTX.caches}>
          <CommandsContext.Provider value={() => commands}>
            <Comp node={measured} />
          </CommandsContext.Provider>
        </CachesContext.Provider>
      </ThemeContext.Provider>
    ),
    host,
  )
  try {
    await document.fonts.ready
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const chips = [...host.querySelectorAll<HTMLElement>('.gg-md-mention[data-mention-kind]')]
    for (const chip of chips) chip.click()
    return chips.length
  } finally {
    dispose()
    host.remove()
  }
}

describe('a file pill opens the way its link does (App 引用 pill)', () => {
  it('one pointing at a group file opens there, with its place; one naming a local path stays the host’s mention', async () => {
    const groupOpens: { itemId: string; at?: Record<string, string> }[] = []
    const mentions: { id: string; kind: string }[] = []
    const commands: ChatCommands = {
      classifyLink: (href: string) => classifyFileLink(href),
      onOpenGroupFile: (arg) => groupOpens.push(arg),
      onClickMention: (arg) => mentions.push({ id: arg.id, kind: arg.kind }),
    }
    const pill = stringifyMention({ label: '演示稿 · 第 3 页 · 标题', target: `gugu-file://${ITEM}?v=7#slide=3&shape=12`, kind: 'file' })
    const local = stringifyMention({ label: 'a.ts', target: '/work/a.ts', kind: 'file' })
    expect(await clickChips(`改这里 ${pill} 和 ${local}`, commands)).toBe(2)
    expect(groupOpens).toEqual([{ itemId: ITEM, at: { slide: '3', shape: '12' } }])
    expect(mentions).toEqual([{ id: '/work/a.ts', kind: 'file' }])
  })

  it('a label with a lone `]` (an App’s shape name) is still a pill, its label whole', async () => {
    const pill = stringifyMention({ label: '图 2]', target: `gugu-file://${ITEM}#slide=5&shape=7`, kind: 'file' })
    const block = parseMarkdownToBlocks('pill', `看 ${pill}`, files).find((b): b is HtmlBlock => b.kind === 'html')!
    const parsed = document.createElement('div')
    parsed.innerHTML = block.html
    expect([...parsed.querySelectorAll('.gg-md-mention')].map((chip) => chip.textContent)).toEqual(['图 2]'])
  })
})

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { chatLinks, openGroupFile, openGroupFileLink } from '../../../../apps/desktop/src/components/markdown/fileLinks'
import { GROUP_FILE_OPEN_EVENT, type GroupFileOpenDetail } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * App 引用 pill: a click on a pill (or on its link anywhere) asks the chat shell to open the file with the place it points
 * at — the same one call a plain file link makes, one field more. `session_open_in_tab` hands the same link the same way.
 */

const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
vi.mock('../../../../apps/desktop/src/lib/supabase', () => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { chat_id: 'chat-1' }, error: null }) }
  return { chatDb: { from: () => query } }
})

async function asked(open: () => unknown): Promise<GroupFileOpenDetail[]> {
  const seen: GroupFileOpenDetail[] = []
  const take = (event: Event) => {
    seen.push((event as CustomEvent<GroupFileOpenDetail>).detail)
    event.preventDefault()
  }
  window.addEventListener(GROUP_FILE_OPEN_EVENT, take)
  open()
  await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0))
  window.removeEventListener(GROUP_FILE_OPEN_EVENT, take)
  return seen
}

describe('opening a group file from a pill’s link carries the place', () => {
  it('a message entry carries its caller\'s restore callback without running it while opening', async () => {
    const restore = vi.fn()
    expect(await asked(() => openGroupFile(ITEM, undefined, undefined, restore))).toEqual([{ chatId: 'chat-1', itemId: ITEM, restore }])
    expect(restore).not.toHaveBeenCalled()
  })
  it('a chat link: the file, its chat, and the place (as written in the link)', async () => {
    const href = `gugu-file://${ITEM}?v=7#slide=3&shape=12`
    expect(await asked(() => chatLinks(undefined)(href))).toEqual([{ chatId: 'chat-1', itemId: ITEM, at: { slide: '3', shape: '12' } }])
  })

  it('session_open_in_tab’s url too; a plain file link carries none', async () => {
    expect(await asked(() => openGroupFileLink(`gugu-file://${ITEM}#range=销售!B2:D4`))).toEqual([{ chatId: 'chat-1', itemId: ITEM, at: { range: '销售!B2:D4' } }])
    expect(await asked(() => chatLinks(undefined)(`gugu-file://${ITEM}`))).toEqual([{ chatId: 'chat-1', itemId: ITEM }])
  })
})

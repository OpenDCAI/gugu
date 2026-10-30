// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

const { start, feedChats } = vi.hoisted(() => ({
  start: vi.fn((_source: SearchBackfillSource, _host: SearchBackfillHost) => () => {}), feedChats: vi.fn(async () => {}),
}))
vi.mock('../../../../apps/desktop/src/lib/searchBackfill', () => ({ startSearchBackfill: start }))
vi.mock('../../../../apps/desktop/src/lib/searchIndexFeed', () => ({ feedChats, feedRows: vi.fn(), feedRemoved: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {} }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({}) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/global-search/global-search-flag', () => ({ useGlobalSearchV3: () => true }))
import { useSearchIndexWiring } from '../../../../apps/desktop/src/store/searchIndexWiring'
import type { SearchBackfillHost, SearchBackfillSource } from '../../../../apps/desktop/src/lib/searchBackfill'

let harness: ReturnType<typeof createReactHarness>
const subscribeAccountRevision = () => () => {}
function Probe() {
  useSearchIndexWiring({ userId: 'me', chats: [], chatsRead: true, activeChatId: null, subscribeAccountRevision })
  return null
}

beforeEach(() => { vi.clearAllMocks(); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.restoreAllMocks() })

describe('search backfill host wiring', () => {
  it('pauses for a hidden or offline window and resumes only when visible and online', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    await harness.render(createNode(Probe))
    expect(start).toHaveBeenCalledTimes(1)
    const host = start.mock.calls[0]![1] as SearchBackfillHost
    expect(host.canRead()).toBe(true)
    hidden.mockReturnValue(true)
    expect(host.canRead()).toBe(false)
    hidden.mockReturnValue(false)
    online.mockReturnValue(false)
    expect(host.canRead()).toBe(false)
    online.mockReturnValue(true)
    expect(host.canRead()).toBe(true)
  })
})

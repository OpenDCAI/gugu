// D-30 (主人 10-06「肯定是能选的啊」): whether an App's tools reach a session — this computer's places, else a chat its owner
// gave it at. An App nobody chose for reaches every agent here (125 10-06).
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({ awaitSessionpageCloudIdentity: async () => {} }))
vi.mock('../../../../apps/desktop/src/session/shared/extensions/app-enablements-core', () => ({ appsGivenTo: async () => new Set(['owner-1/searcher']) }))

const { appScopeOf, inAppScope } = await import('../../../../apps/desktop/electron/app-scope')
const { HERE_ALL } = await import('../../../../apps/desktop/src/session/shared/extensions/host-actions')

const scope = () => Promise.resolve(new Set(['owner-1/searcher']))

describe('which sessions an App reaches (D-30)', () => {
  it('nobody chose: every agent here; every agent chosen: the same', async () => {
    expect(await inAppScope(null, 'owner-1/other', scope)).toBe(true)
    expect(await inAppScope([HERE_ALL], null, () => Promise.resolve(new Set()))).toBe(true)
  })

  // 主人 10-16: 「不在项目里的 agent」 is no place any more. A computer still keeping it gives no one anything by it — not even
  // an agent in no project — and is never read as 「nobody chose」 (every agent).
  it("the removed 「agents in no project」, still kept, gives nothing; the chats' half still does", async () => {
    expect(await inAppScope(['here:projectless'], 'owner-1/other', scope)).toBe(false)
    expect(await inAppScope(['here:projectless'], 'owner-1/searcher', scope)).toBe(true)
  })

  it("else only a chat its owner gave it at, and the agent is in — none chosen here and none there: no one", async () => {
    expect(await inAppScope([], 'owner-1/searcher', scope)).toBe(true)
    expect(await inAppScope([], 'owner-1/other', scope)).toBe(false)
    expect(await inAppScope([], null, scope)).toBe(false)
  })

  // 编号 4 (10-12 片场试演): the App was given to the group after the lead's session opened, and the session kept saying「not
  // given」until it was restarted. The chats' half is read at every ask now — and only when this computer's places don't settle it.
  it('a chat given while the session runs counts from the next ask; never read when this computer already gives it', async () => {
    const given = new Set<string>()
    let reads = 0
    const live = () => {
      reads += 1
      return Promise.resolve(new Set(given))
    }
    expect(await inAppScope([], 'owner-1/studio', live)).toBe(false)
    given.add('owner-1/studio')
    expect(await inAppScope([], 'owner-1/studio', live)).toBe(true)
    expect(reads).toBe(2)
    for (const here of [null, [HERE_ALL]]) expect(await inAppScope(here, 'owner-1/studio', live)).toBe(true)
    expect(reads).toBe(2)
  })

  it("reads the owner's rows as the owner, for the agent", async () => {
    expect(await appScopeOf('agent-1', async () => ({ accessToken: 't', userId: 'owner-1' }))).toEqual(new Set(['owner-1/searcher']))
  })
})

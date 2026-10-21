// #6475 opencode 家的 TUI 腿是 serve/attach:这一家拟的会话名随 serve 的 `/event` SSE 里的
// `session.updated` 到(2026-09-25 mac1 opencode 1.18.25 实测:ses_… 会话在 serve 库里拟名为
// 「Quick check-in」,而那一版咕咕没读这条事件,侧栏停在首句)。这里直接喂 SSE 帧给 transport。
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { OpencodeServeSession } from '../../../../apps/desktop/electron/sessionpage/opencode-serve-attach-transport'

function serveSession() {
  const titles: string[] = []
  const session = new OpencodeServeSession(0, {
    providerId: 'opencode',
    command: 'opencode',
    cwd: os.tmpdir(),
    env: {},
    onSessionTitle: (title) => titles.push(title),
  })
  session.providerSessionId = 'ses_1'
  const updated = (info: Record<string, unknown>, sessionID = String(info.id)) =>
    (session as unknown as { consumeFrame(frame: string): void }).consumeFrame(
      `data: ${JSON.stringify({ type: 'session.updated', properties: { sessionID, info } })}`,
    )
  return { titles, updated }
}

describe('OpencodeServeSession: session.updated → session title', () => {
  it('reports the generated title once, after the placeholder', () => {
    const { titles, updated } = serveSession()
    updated({ id: 'ses_1', title: 'New session - 2026-09-25T03:59:35.000Z' })
    updated({ id: 'ses_1', title: 'Quick check-in' })
    updated({ id: 'ses_1', title: 'Quick check-in' })
    expect(titles).toEqual(['Quick check-in'])
  })

  it("ignores another session's update and child sessions on the same serve", () => {
    const { titles, updated } = serveSession()
    updated({ id: 'ses_2', title: 'Other session' })
    updated({ id: 'ses_3', parentID: 'ses_1', title: 'Explore auth code' })
    expect(titles).toEqual([])
  })

  it('a later rename in the TUI is reported again', () => {
    const { titles, updated } = serveSession()
    updated({ id: 'ses_1', title: 'Fix login', titleSource: 'generated' })
    updated({ id: 'ses_1', title: 'My name', titleSource: 'user' })
    expect(titles).toEqual(['Fix login', 'My name'])
  })
})

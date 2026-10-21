import { describe, expect, it, vi } from 'vitest'
import { messageHost } from '../../../../apps/desktop/src/session/app-runtime/framed-host'
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * App 引用 pill: on the phone a page gets the place a pill points at through `gugu.onLink`, as a desktop page does — and
 * the event may arrive while the page's script is still loading, so the frame holds it for the first subscriber (the
 * desktop preload holds a link the same way).
 */

function frameHost(flags: { framed?: true; program?: true } = { framed: true }) {
  let deliver: (message: unknown) => void = () => {}
  const host = messageHost({ post: vi.fn(), listen: (handler) => (deliver = handler) }, flags)
  const link = (query: Record<string, string>) =>
    deliver({ m: APP_FRAME_MARKER, t: 'event', event: { type: 'link', tab: 'main', path: '', query, file: 'deck-1' } })
  return { host: host as unknown as { onLink?: (fn: (link: unknown) => void) => () => void }, link }
}

describe('a framed page hears a pill’s place through onLink', () => {
  it('one that came before the page subscribed is handed to the first subscriber; later ones as they come', () => {
    const { host, link } = frameHost()
    link({ slide: '3', shape: '12' })
    const heard: unknown[] = []
    host.onLink!((value) => heard.push(value))
    // `file` comes through as the host sent it (#7257): the page tells its file's place by it.
    expect(heard).toEqual([{ tab: 'main', path: '', query: { slide: '3', shape: '12' }, file: 'deck-1' }])
    link({ slide: '5' })
    expect(heard).toEqual([
      { tab: 'main', path: '', query: { slide: '3', shape: '12' }, file: 'deck-1' },
      { tab: 'main', path: '', query: { slide: '5' }, file: 'deck-1' },
    ])
  })

  it('control: a program has no tab, and no onLink', () => {
    expect(frameHost({ program: true }).host.onLink).toBeUndefined()
  })
})

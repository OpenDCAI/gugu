import { describe, expect, it, vi } from 'vitest'
import { APPS_DOMAIN, appFrameChannel, appOrigin } from '../../../../apps/desktop/src/components/appSlot/appOrigin'

// L9 / 摩擦单 F76: on the phone an App's frame is `allow-scripts allow-same-origin` (and `allow-forms`), which is only safe while the App's
// origin is never the gugu page's own — a same-origin frame could lift its sandbox and reach the page's credentials.

const SHELL_ORIGIN = 'https://localhost'

describe('appOrigin: where an App runs on the phone', () => {
  it('is never the shell page origin, for any App', () => {
    for (const id of ['workspace', 'localhost', 'you-draw-i-guess', 'a'.repeat(64)]) {
      const origin = appOrigin(id)
      expect(new URL(origin).origin).toBe(origin)
      expect(origin).not.toBe(SHELL_ORIGIN)
      expect(new URL(origin).hostname.endsWith(`.${APPS_DOMAIN}`)).toBe(true)
    }
  })

  it('is its own for each App, the same whoever is signed in (主人 10-01)', () => {
    expect(appOrigin('vote')).toBe('https://vote.apps.gugu.invalid')
    expect(appOrigin('vote')).not.toBe(appOrigin('poll'))
  })

  it('refuses anything but an App id: nothing else can shape the host', () => {
    expect(() => appOrigin('localhost:443')).toThrow('not an App id')
    expect(() => appOrigin('x.localhost')).toThrow('not an App id')
    expect(() => appOrigin('')).toThrow('not an App id')
  })
})

// L3 review of L9: what goes into an App frame (the host's answers, the sync port with the group file's bytes) is for the
// App's own document only, and only that document is listened to — a second line behind the shell's navigation rule.
describe('appFrameChannel: messages only with the App document', () => {
  const ORIGIN = 'https://vote.apps.gugu.invalid'
  const frameAt = (src: string) => {
    const postMessage = vi.fn()
    return { frame: { src, contentWindow: { postMessage } as unknown as Window }, postMessage }
  }

  it('posts to the origin its src names, with what it hands over — never "*"', () => {
    const { frame, postMessage } = frameAt(`${ORIGIN}/more/page.html`)
    const { port1, port2 } = new MessageChannel()
    expect(appFrameChannel(frame).post({ hello: 1 }, [port1])).toBe(true)
    expect(postMessage.mock.calls).toEqual([[{ hello: 1 }, ORIGIN, [port1]]])
    port1.close()
    port2.close()
  })

  it('posts nothing where no App document can be named', () => {
    for (const src of ['', 'about:blank', 'not a url']) {
      const { frame, postMessage } = frameAt(src)
      expect(appFrameChannel(frame).post({ hello: 1 })).toBe(false)
      expect(postMessage).not.toHaveBeenCalled()
    }
  })

  it('listens to its App document only: its window and its origin', () => {
    const { frame } = frameAt(`${ORIGIN}/index.html`)
    const channel = appFrameChannel(frame)
    const own = frame.contentWindow as unknown as MessageEventSource
    expect(channel.accepts({ source: own, origin: ORIGIN })).toBe(true)
    // Its window, showing another document (had it got past the shell's rule): not heard.
    expect(channel.accepts({ source: own, origin: 'https://example.com' })).toBe(false)
    expect(channel.accepts({ source: own, origin: 'null' })).toBe(false)
    // Another window with the right origin (another frame of the same App): not this frame's.
    expect(channel.accepts({ source: {} as MessageEventSource, origin: ORIGIN })).toBe(false)
    expect(channel.accepts({ source: null, origin: ORIGIN })).toBe(false)
  })

  it('control: the check before (the window alone) heard that window after it left its origin', () => {
    const { frame } = frameAt(`${ORIGIN}/index.html`)
    const sourceOnly = (event: { source: unknown }) => event.source === frame.contentWindow
    expect(sourceOnly({ source: frame.contentWindow })).toBe(true)
    expect(appFrameChannel(frame).accepts({ source: frame.contentWindow as unknown as MessageEventSource, origin: 'https://example.com' })).toBe(false)
  })
})

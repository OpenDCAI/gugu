// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startGate } from '../../../../apps/desktop/src/session/app-runtime/gate'
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { messageHost } from '../../../../apps/desktop/src/session/app-runtime/framed-host'

/**
 * The phone's gate (gate.ts): what the gugu page hears from an App goes through it, and the one thing it changes is the
 * gesture of a call — its own reading, over whatever the App wrote. jsdom's top window stands in for the gate's window;
 * its `parent` is itself, so what the gate posts to the gugu page lands on the spied `postMessage`.
 */

const GATE = { origin: 'https://board.gate.gugu.invalid', search: '?page=more%2Fpage.html' }
const APP = 'https://board.apps.gugu.invalid'
const activation = { isActive: false }
Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true })

let frame: HTMLIFrameElement
let toPage: ReturnType<typeof vi.fn>
let toApp: ReturnType<typeof vi.fn>
const fromApp = (data: unknown, source: MessageEventSource | null = frame.contentWindow, origin = APP) =>
  window.dispatchEvent(new MessageEvent('message', { data, source, origin }))
const call = (extra: Record<string, unknown> = {}) => ({ m: APP_FRAME_MARKER, t: 'call', id: 1, method: 'clipboardWriteText', args: { text: 'x' }, ...extra })

beforeEach(() => {
  toPage = vi.fn()
  vi.spyOn(window, 'postMessage').mockImplementation(toPage as never)
  window.name = 'gugu-session'
  frame = startGate(window, GATE)
  toApp = vi.fn()
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: toApp, configurable: true })
})
afterEach(() => {
  frame.remove()
  vi.restoreAllMocks()
  activation.isActive = false
})

describe('the gate frames its own App', () => {
  it("frames the named page in the App's origin, under the gugu page's frame name", () => {
    expect(frame.src).toBe(`${APP}/more/page.html`)
    expect(frame.name).toBe('gugu-session')
  })

  it("refuses to run anywhere but a gate origin, or to frame another origin's page", () => {
    expect(() => startGate(window, { origin: APP, search: '?page=index.html' })).toThrow(/gate origin/)
    expect(() => startGate(window, { origin: GATE.origin, search: '?page=https%3A%2F%2Fevil.example%2F' })).toThrow(/own App/)
  })
})

describe("a call's gesture is the gate's reading, never the App's word", () => {
  it('outside the person\'s input, a call the App marks gesture:true leaves as false', () => {
    activation.isActive = false
    fromApp(call({ gesture: true }))
    expect(toPage).toHaveBeenCalledTimes(1)
    expect(toPage.mock.calls[0]![0]).toMatchObject({ t: 'call', method: 'clipboardWriteText', gesture: false })
  })

  it('inside it, a call the App marks false (or not at all) leaves as true', () => {
    activation.isActive = true
    fromApp(call({ gesture: false }))
    fromApp(call())
    expect(toPage.mock.calls.map(([message]) => (message as { gesture: unknown }).gesture)).toEqual([true, true])
  })

  it('anything else the App says passes unchanged, its ports with it', () => {
    const hello = { m: APP_FRAME_MARKER, t: 'hello', gesture: true }
    fromApp(hello)
    expect(toPage.mock.calls[0]![0]).toBe(hello)
  })
})

describe('the gate listens to its App and to the gugu page, nobody else', () => {
  it('carries a binary range through the gate and framed host without JSON conversion', async () => {
    let deliver!: (message: unknown) => void
    let request!: { id: number }
    const host = messageHost({ post: message => { request = message as { id: number } }, listen: listener => { deliver = listener } }, { framed: true })
    const pending = host.appFiles.read({ ref: { id: 'file', version: 1 }, offset: 0, length: 3 })
    toApp.mockImplementation(message => deliver(structuredClone(message)))
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: 'https://localhost', data: structuredClone({ m: APP_FRAME_MARKER, t: 'result', id: request.id, ok: true, value: { size: 3, offset: 0, data: new Uint8Array([0, 255, 128]) } }) }))
    const reply = await pending
    // Node's structuredClone in jsdom returns its own realm's typed arrays, as a real receiving window does.
    expect(reply.data).toBeInstanceOf(structuredClone(new Uint8Array()).constructor)
    expect([...reply.data]).toEqual([0, 255, 128])
    expect(reply.data.buffer.byteLength).toBe(3)
  })

  it('a message from another window, or from the App\'s window in another origin, is dropped', () => {
    const other = document.createElement('iframe')
    document.body.append(other)
    activation.isActive = true
    fromApp(call(), other.contentWindow)
    fromApp(call(), frame.contentWindow, 'https://radar.apps.gugu.invalid')
    fromApp(call(), frame.contentWindow, 'https://board.gate.gugu.invalid')
    expect(toPage).not.toHaveBeenCalled()
    other.remove()
  })

  it("what the gugu page sends goes on to the App's document only, by its origin", () => {
    const event = { m: APP_FRAME_MARKER, t: 'event', event: { type: 'command', commandId: 'copy' } }
    window.dispatchEvent(new MessageEvent('message', { data: event, source: window, origin: 'https://localhost' }))
    expect(toApp).toHaveBeenCalledWith(event, APP, [])
    expect(toPage).not.toHaveBeenCalled()
  })
})

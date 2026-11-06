import { describe, expect, it } from 'vitest'
import { decodeHostWsMessage, encodeHostWsMessage } from './host-ws-protocol'

/** What the host's handler is called with after the frame crossed the wire. */
function argsOnHost(args: unknown[]): unknown[] {
  const decoded = decodeHostWsMessage(
    encodeHostWsMessage({ t: 'invoke', id: 1, channel: 'agents.install', args }),
  )
  if (decoded?.t !== 'invoke') throw new Error('expected an invoke frame')
  return decoded.args
}

describe('invoke frames carry arguments the way Electron IPC does', () => {
  it('an omitted trailing argument reaches the host as undefined, not null', () => {
    // 资源库「安装」在下载源为「自动」时发的就是这一条。
    const [, , registry] = argsOnHost(['codex', 'mise', undefined])
    expect(registry).toBeUndefined()
  })

  it('keeps every argument that was given, including null and bytes', () => {
    const args = argsOnHost(['a', null, new Uint8Array([1, 2]), undefined, undefined])
    expect(args).toEqual(['a', null, new Uint8Array([1, 2])])
  })
})

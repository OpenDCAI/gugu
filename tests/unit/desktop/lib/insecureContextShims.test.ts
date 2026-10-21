import { describe, expect, it } from 'vitest'
import { installInsecureContextShims, randomUuidV4 } from '../../../../apps/desktop/src/lib/insecure-context-shims'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('insecure-context shims (web form opened over plain http://<ip>)', () => {
  it('fills in crypto.randomUUID when the browser withholds it', () => {
    // 模拟非安全上下文:有 getRandomValues、没有 randomUUID。
    const fake = { getRandomValues: <T extends ArrayBufferView<ArrayBuffer>>(a: T) => crypto.getRandomValues(a) } as unknown as Crypto
    expect(typeof (fake as { randomUUID?: unknown }).randomUUID).toBe('undefined')
    installInsecureContextShims(fake)
    const id = fake.randomUUID()
    expect(id).toMatch(V4)
    expect(fake.randomUUID()).not.toBe(id)
  })

  it('leaves a native randomUUID alone', () => {
    const native = () => 'native' as const
    const fake = { getRandomValues: () => new Uint8Array(16), randomUUID: native } as unknown as Crypto
    installInsecureContextShims(fake)
    expect(fake.randomUUID).toBe(native)
  })

  it('produces RFC 4122 v4 ids from getRandomValues', () => {
    for (let i = 0; i < 50; i += 1) expect(randomUuidV4()).toMatch(V4)
  })
})

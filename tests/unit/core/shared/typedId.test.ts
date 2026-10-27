import { describe, expect, it } from 'vitest'
import { decodeIdentityAddress, decodeTypedId, encodeTypedId, readTypedIdLenient } from '@gugu/core/shared/typedId.mjs'

// #5048 身份地址两形(user:<uuid> / gugu:<咕咕号>)的唯一语法入口。裸值、别的类型、坏号都当场响。
describe('decodeIdentityAddress', () => {
  const uuid = '11111111-1111-4111-8111-111111111111'

  it.each([
    // `aid:` 是产品面的写法(分享浮层那一栏就叫 Agent ID);`user:` 是它 2026-09-16 之前的旧拼法,
    // 继续收 —— 线上已有带 `user:` 的会话记录与排队消息,改名不能让它们当场失效。两种解出同一个东西。
    { label: 'agent id address', value: `aid:${uuid}`, path: 'to', expected: { kind: 'user', id: uuid } },
    { label: 'trimmed agent id address', value: `  aid:${uuid}  `, path: 'to', expected: { kind: 'user', id: uuid } },
    { label: 'legacy user address', value: `user:${uuid}`, path: 'to', expected: { kind: 'user', id: uuid } },
    { label: 'trimmed legacy user address', value: `  user:${uuid}  `, path: 'to', expected: { kind: 'user', id: uuid } },
    { label: 'small gugu number', value: 'gugu:8', path: 'to', expected: { kind: 'gugu', number: 8 } },
    { label: 'large gugu number', value: 'gugu:157330', path: 'to[0]', expected: { kind: 'gugu', number: 157330 } },
  ])('$label decodes to its canonical identity', ({ value, path, expected }) => {
    expect(decodeIdentityAddress(value, path)).toEqual(expected)
  })

  it('rejects a bare uuid and a bare number by name, pointing at both forms', () => {
    expect(() => decodeIdentityAddress(uuid, 'to[1]')).toThrow(/to\[1\].*aid:<Agent ID> or gugu:<咕咕号>.*bare value/)
    expect(() => decodeIdentityAddress('8', 'to')).toThrow(/bare value "8"/)
  })

  it('rejects another id kind and malformed numbers', () => {
    expect(() => decodeIdentityAddress('session:abc', 'to')).toThrow(/got a session: id/)
    expect(() => decodeIdentityAddress('gugu:', 'to')).toThrow(/positive integer/)
    expect(() => decodeIdentityAddress('gugu:0', 'to')).toThrow(/positive integer/)
    expect(() => decodeIdentityAddress('gugu:-3', 'to')).toThrow(/positive integer/)
    expect(() => decodeIdentityAddress('gugu:1234567890', 'to')).toThrow(/1-9 digits/)
    expect(() => decodeIdentityAddress('aid:', 'to')).toThrow(/has no Agent ID after the prefix/)
    expect(() => decodeIdentityAddress('user:', 'to')).toThrow(/has no Agent ID after the prefix/)
    expect(() => decodeIdentityAddress('', 'to')).toThrow(/expected an identity address/)
    expect(() => decodeIdentityAddress(42, 'to')).toThrow(/expected an identity address/)
  })

  it('keeps the older single-kind decoders strict: user: still refuses gugu:', () => {
    expect(() => decodeTypedId('user', 'gugu:8', 'user_id')).toThrow(/expected a user: id but got a gugu: id/)
    // gugu 已是已知前缀:宽松读法对错类前缀回 null,而不是把 "gugu:8" 当裸 id 放过去。
    expect(readTypedIdLenient('user', 'gugu:8')).toBeNull()
  })
})

// A message the host writes itself (the turn-failure notice) is stored under a structured key. Any reader that
// meets it — an agent whose message that notice answers — must address it, not refuse it as already typed.
describe('encodeTypedId with structured storage ids', () => {
  const notice = 'turn-failure:batch:6b62191fcf9bbff3312a90753053be57'

  it('encodes a stored id that contains colons and decodes it back unchanged', () => {
    const typed = encodeTypedId('msg', notice)
    expect(typed).toBe(`msg:${notice}`)
    expect(decodeTypedId('msg', typed, 'message_id')).toBe(notice)
    expect(readTypedIdLenient('msg', typed)).toBe(notice)
    expect(readTypedIdLenient('msg', notice)).toBe(notice)
  })

  it('still refuses an id that already carries a type prefix', () => {
    const uuid = '11111111-1111-4111-8111-111111111111'
    expect(() => encodeTypedId('msg', `msg:${uuid}`)).toThrow(/refusing to double-encode "msg:/)
    expect(() => encodeTypedId('session', `project:${uuid}`)).toThrow(/refusing to double-encode/)
    expect(() => encodeTypedId('user', `aid:${uuid}`)).toThrow(/refusing to double-encode/)
    expect(() => encodeTypedId('msg', '')).toThrow(/empty msg id/)
  })
})

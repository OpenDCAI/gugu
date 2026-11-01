import { describe, expect, it } from 'vitest'
import { parseWidgetMessage, serializeWidgetMessage } from '@gugu/core/shared/ui/widgetModels'

const widget = { v: 2 as const, text: 'Build results', app: 'board', view: 'main', data: { count: 1 } }
describe('widget messages', () => {
  it('keeps immutable input fields and ignores future v2 keys', () => {
    expect(parseWidgetMessage(JSON.stringify({ ...widget, future: true }))).toEqual(widget)
    expect(parseWidgetMessage(serializeWidgetMessage(widget))).toEqual(widget)
    expect(parseWidgetMessage(JSON.stringify({ ...widget, text: ' ' }))).not.toBeNull()
  })
  it('requires numeric v2 and never copies prototype keys into the model', () => {
    expect(parseWidgetMessage(JSON.stringify({ ...widget, v: '2' }))).toBeNull()
    const content = '{"v":2,"text":"OK","app":"board","view":"main","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"data":{"__proto__":{"count":3}}}'
    const parsed = parseWidgetMessage(content)!
    expect(Object.hasOwn(parsed, '__proto__')).toBe(false)
    expect(Object.hasOwn(parsed, 'constructor')).toBe(false)
    expect(Object.hasOwn(parsed.data!, '__proto__')).toBe(true)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
  it.each([null, '', '{', '[]', JSON.stringify({ ...widget, v: 1 }), JSON.stringify({ ...widget, data: [] }), JSON.stringify({ ...widget, text: '' }), JSON.stringify({ ...widget, id: 'old', title: 'old' }), JSON.stringify({ ...widget, id: 'old' }), JSON.stringify({ ...widget, title: 'old' })])('refuses malformed and legacy content %s', content => {
    expect(parseWidgetMessage(content)).toBeNull()
  })
  it('measures data in UTF-8 bytes and counts text characters', () => {
    expect(() => serializeWidgetMessage({ ...widget, data: { s: '界'.repeat(1363) } })).toThrow('4097 UTF-8 bytes')
    expect(parseWidgetMessage(JSON.stringify({ ...widget, text: '😀'.repeat(200) }))).not.toBeNull()
    expect(parseWidgetMessage(JSON.stringify({ ...widget, text: '😀'.repeat(201) }))).toBeNull()
    expect(parseWidgetMessage(JSON.stringify({ ...widget, future: 'a'.repeat(6144) }))).toBeNull()
    expect(() => serializeWidgetMessage({ ...widget, text: '\u0000'.repeat(200), app: 'a'.repeat(5000) })).toThrow('content is')
  })
})

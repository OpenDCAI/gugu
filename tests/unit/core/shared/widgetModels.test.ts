import { describe, expect, it } from 'vitest'
import { parseWidgetMessage, serializeWidgetMessage, widgetMessageError, widgetMessagePreview } from '@gugu/core/shared/ui/widgetModels'

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
  it.each([64, 140, 480, 520])('round-trips the immutable message height %s', height => {
    const input = { ...widget, height }
    expect(parseWidgetMessage(serializeWidgetMessage(input))).toEqual(input)
  })
  it.each([63, 521, 300.5, null, '480'])('rejects an invalid message height %s at the render boundary', height => {
    const input = { ...widget, height }
    expect(widgetMessageError(input)).toMatch(/height.*64.*520/)
    expect(parseWidgetMessage(JSON.stringify(input))).toBeNull()
  })
  it.each([63, 521, 300.5])('refuses to serialize invalid height %s', height => {
    expect(() => serializeWidgetMessage({ ...widget, height })).toThrow(/height.*64.*520/)
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
  it('also bounds the original data representation, including whitespace and escaped keys', () => {
    const spaced = '{"v":2,"text":"OK","app":"board","view":"main","data":{' + ' '.repeat(4095) + '}}'
    expect(new TextEncoder().encode(spaced).length).toBeLessThan(6144)
    expect(parseWidgetMessage(spaced)).toBeNull()
    expect(parseWidgetMessage(spaced.replace('"data"', '"d\\u0061ta"'))).toBeNull()
    expect(parseWidgetMessage('{"v":2,"text":"data","app":"board","view":"main","data":{"nested":{"value":"data"}}}')).not.toBeNull()
    expect(parseWidgetMessage(spaced.slice(0, -1) + ',"data":{}}')).not.toBeNull()
  })
  it('reads a cut reply preview without displaying the App payload or splitting escapes', () => {
    const content = serializeWidgetMessage({ ...widget, text: 'Results: "three"\n界', data: { large: 'a'.repeat(3000) } })
    expect(widgetMessagePreview(content.slice(0, 280))).toBe('Results: "three"\n界')
    expect(widgetMessagePreview('{"v":2,"text":"OK\\u12')).toBe('OK')
    expect(widgetMessagePreview('{"v":"2","text":"wrong"}')).toBeNull()
  })
})

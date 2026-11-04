// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyDocumentPreview } from '../../../apps/desktop/src/components/chat/documentPreview'
import { attachmentTypeKey } from '../../../apps/desktop/src/components/chat/attachmentType'
import { isExtensionBundle } from '../../../apps/desktop/src/components/extensionBundle/summarizeExtensionBundle'

const source = readFileSync('apps/mobile/android/app/src/main/AndroidManifest.xml', 'utf8')
const manifest = new DOMParser().parseFromString(source, 'application/xml')
const android = 'http://schemas.android.com/apk/res/android'
const attribute = (node: Element, name: string) => node.getAttributeNS(android, name)
const filters = [...manifest.querySelectorAll('activity > intent-filter')]

function matches(action: string, mime: string, scheme = 'content'): boolean {
  return filters.some(filter => {
    if (![...filter.querySelectorAll('action')].some(node => attribute(node, 'name') === `android.intent.action.${action}`)) return false
    const data = [...filter.querySelectorAll('data')]
    const schemes = data.flatMap(node => attribute(node, 'scheme') ?? [])
    // Android combines the data elements within one filter; types and schemes in other filters do not leak into it.
    if (schemes.length ? !schemes.includes(scheme) : !['content', 'file'].includes(scheme)) return false
    return data.some(node => {
      const type = attribute(node, 'mimeType')
      return type === '*/*' || type === mime || type === `${mime.split('/')[0]}/*`
    })
  })
}

const view = filters.find(filter => [...filter.querySelectorAll('action')].some(node => attribute(node, 'name') === 'android.intent.action.VIEW')
  && [...filter.querySelectorAll('data')].some(node => attribute(node, 'scheme') === 'content'))!
const declaredTypes = [...view.querySelectorAll('data')].flatMap(node => attribute(node, 'mimeType') ?? [])

describe('Android Open with registration', () => {
  it.each(['application/vnd.android.package-archive', 'application/octet-stream', 'vnd.android.document/directory',
    'application/x-executable', 'application/x-msdownload', 'application/x-7z-compressed', 'application/x-rar-compressed', 'application/epub+zip'])('does not offer a VIEW handler for %s', mime => {
    expect(matches('VIEW', mime)).toBe(false)
  })

  it.each(['application/pdf', 'image/png', 'image/jpeg', 'text/markdown', 'text/plain', 'video/mp4', 'audio/mpeg'])('preserves the existing content-URI entry for %s', mime => {
    expect(matches('VIEW', mime)).toBe(true)
    expect(matches('VIEW', mime, 'file')).toBe(false)
    expect(matches('VIEW', mime, 'https')).toBe(false)
  })

  it('registers concrete application types handled by the existing preview or file-card paths', () => {
    const types = declaredTypes.filter(type => type.startsWith('application/'))
    expect(types.length).toBeGreaterThan(0)
    for (const mimeType of types) {
      expect(mimeType).not.toContain('*')
      const file = { fileName: 'without-an-extension', mimeType }
      expect(classifyDocumentPreview(file) !== 'unsupported' || attachmentTypeKey(file) !== null || isExtensionBundle(file), mimeType).toBe(true)
    }
  })

  it('keeps every concrete application MIME already named in the preview, file-card and shared type lists', () => {
    const paths = ['apps/desktop/src/components/chat/documentPreview.ts', 'apps/desktop/src/components/chat/attachmentType.ts', 'packages/core/src/shared/imageMime.mjs']
    const known = new Set(paths.flatMap(path => [...readFileSync(path, 'utf8').matchAll(/['"](application\/[a-z0-9.+-]+)['"]/g)].map(match => match[1]!)))
    known.delete('application/octet-stream') // A transport placeholder, not an advertised file format.
    for (const mime of known) expect(matches('VIEW', mime), mime).toBe(true)
  })

  it.each(['application/javascript', 'application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/toml', 'application/csv'])('keeps structured text %s on the existing text-preview path', mimeType => {
    expect(classifyDocumentPreview({ fileName: 'without-an-extension', mimeType })).toBe('text')
    expect(matches('VIEW', mimeType)).toBe(true)
  })

  it('does not change explicit SEND or SEND_MULTIPLE attachment sharing', () => {
    for (const action of ['SEND', 'SEND_MULTIPLE']) {
      for (const mime of ['application/vnd.android.package-archive', 'application/octet-stream', 'application/pdf', 'text/plain', 'image/png']) {
        expect(matches(action, mime)).toBe(true)
      }
    }
  })
})

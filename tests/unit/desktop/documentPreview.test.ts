import { describe, expect, it } from 'vitest'
import { classifyDocumentPreview } from '@/components/chat/documentPreview'

describe('document preview image dispatch', () => {
  it('sends renderable images to the shared image viewer, including generic MIME types and SVG', () => {
    for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'apng', 'bmp', 'ico']) {
      expect(classifyDocumentPreview({ fileName: `picture.${extension}`, mimeType: 'application/octet-stream' })).toBe('image')
    }
    expect(classifyDocumentPreview({ fileName: 'picture', mimeType: 'IMAGE/PNG; charset=binary' })).toBe('image')
    expect(classifyDocumentPreview({ fileName: 'drawing.svg', mimeType: 'image/svg+xml' })).toBe('image')
    for (const extension of ['heic', 'heif', 'tiff']) {
      expect(classifyDocumentPreview({ fileName: `picture.${extension}`, mimeType: '' })).toBe('unsupported')
    }
  })
})

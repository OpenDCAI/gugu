import { describe, expect, it } from 'vitest'
import { mosaicPixels } from '../../../../apps/desktop/src/components/imageAnnotate/annotatePixels'

const pixels = () => new Uint8ClampedArray([
  0, 0, 0, 255, 100, 20, 40, 255, 240, 0, 0, 255, 240, 100, 0, 255,
  200, 40, 80, 255, 100, 20, 40, 255, 240, 0, 100, 255, 240, 100, 100, 255,
])
describe('pixel mosaic', () => {
  it('replaces underlying RGBA detail with cell averages, leaving the original bytes untouched', () => {
    const original = pixels(), working = original.slice()
    mosaicPixels(working, 4, 2, { x: 0, y: 0, width: 4, height: 2 }, 2)
    expect(Array.from(working.slice(0, 8))).toEqual([100, 20, 40, 255, 100, 20, 40, 255])
    expect(Array.from(working.slice(8, 16))).toEqual([240, 50, 50, 255, 240, 50, 50, 255])
    expect(Array.from(working.slice(16, 24))).toEqual([100, 20, 40, 255, 100, 20, 40, 255])
    expect(original).toEqual(pixels())
    expect(working).not.toEqual(original)
  })
  it('clips edge cells and changes no pixel outside the selected region', () => {
    const data = pixels(), original = data.slice()
    mosaicPixels(data, 4, 2, { x: 1, y: -2, width: 1, height: 8 }, 12)
    for (const index of [0, 2, 3, 4, 6, 7]) expect(data.slice(index * 4, index * 4 + 4)).toEqual(original.slice(index * 4, index * 4 + 4))
    expect(Array.from(data.slice(4, 8))).toEqual([100, 20, 40, 255])
  })
  it('rejects invalid buffers and an invalid cell size before editing bytes', () => {
    expect(() => mosaicPixels(pixels(), 3, 2, { x: 0, y: 0, width: 2, height: 2 })).toThrow()
    expect(() => mosaicPixels(pixels(), 4, 2, { x: 0, y: 0, width: 2, height: 2 }, 0)).toThrow()
  })
})

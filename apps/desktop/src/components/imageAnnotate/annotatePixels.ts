import { intersect, type Box } from './annotateModel'

/** Mutates only the working bitmap, with averaged RGBA cells, not an opaque cover. */
export function mosaicPixels(data: Uint8ClampedArray, width: number, height: number, area: Box, cellSize = 12): void {
  if (data.length !== width * height * 4 || !Number.isInteger(cellSize) || cellSize < 1) throw new Error('Invalid pixel buffer or cell size')
  const region = intersect({ x: 0, y: 0, width, height }, area)
  if (!region) return
  const left = Math.max(0, Math.floor(region.x)), top = Math.max(0, Math.floor(region.y))
  const right = Math.min(width, Math.ceil(region.x + region.width)), bottom = Math.min(height, Math.ceil(region.y + region.height))
  for (let y = top; y < bottom; y += cellSize) for (let x = left; x < right; x += cellSize) {
    const xEnd = Math.min(x + cellSize, right), yEnd = Math.min(y + cellSize, bottom)
    const sum = [0, 0, 0, 0], count = (xEnd - x) * (yEnd - y)
    for (let py = y; py < yEnd; py++) for (let px = x; px < xEnd; px++) {
      const offset = (py * width + px) * 4
      for (let c = 0; c < 4; c++) sum[c] += data[offset + c]
    }
    const average = sum.map(value => Math.round(value / count))
    for (let py = y; py < yEnd; py++) for (let px = x; px < xEnd; px++) {
      const offset = (py * width + px) * 4
      for (let c = 0; c < 4; c++) data[offset + c] = average[c]
    }
  }
}

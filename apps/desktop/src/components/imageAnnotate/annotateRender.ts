import { fetchBlob } from '@/lib/download'
import type { ImageViewerItem } from '@/lib/imageViewer'
import { boundsOf, intersect, markersOf, type AnnotateColor, type AnnotateDocument, type Box, type Shape } from './annotateModel'
import { mosaicPixels } from './annotatePixels'

export type AnnotateColors = Record<AnnotateColor | 'ink' | 'shadow', string>
export async function loadAnnotationImage(item: ImageViewerItem): Promise<HTMLImageElement> {
  // A thumbnail is never silently substituted for the original.
  const blob = await fetchBlob(item.full ? await item.full() : item.url)
  const url = URL.createObjectURL(blob)
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode the original image')) }
    image.src = url
  })
}
export function annotationColors(element: HTMLElement): AnnotateColors {
  const probe = document.createElement('span')
  element.append(probe)
  const result = {} as AnnotateColors
  for (const name of ['danger', 'warn', 'live', 'ok', 'white'] as const) {
    probe.style.color = name === 'white' ? 'var(--color-white)' : `var(--${name})`
    result[name] = getComputedStyle(probe).color
  }
  probe.style.color = 'var(--image-bg)'; result.ink = getComputedStyle(probe).color
  probe.style.color = 'color-mix(in srgb, var(--image-bg) 25%, transparent)'; result.shadow = getComputedStyle(probe).color
  probe.remove()
  return result
}
const contextOf = (canvas: HTMLCanvasElement) => {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is unavailable')
  return ctx
}
export function renderBackground(canvas: HTMLCanvasElement, image: HTMLImageElement, doc: AnnotateDocument): void {
  const working = document.createElement('canvas')
  working.width = doc.width; working.height = doc.height
  const pixels = contextOf(working)
  pixels.drawImage(image, 0, 0)
  for (const shape of doc.shapes) {
    if (shape.kind !== 'mosaic') continue
    const box = intersect(shape.box, { x: 0, y: 0, width: doc.width, height: doc.height })
    if (!box) continue
    const x = Math.floor(box.x), y = Math.floor(box.y)
    const width = Math.ceil(box.x + box.width) - x, height = Math.ceil(box.y + box.height) - y
    const patch = pixels.getImageData(x, y, width, height)
    mosaicPixels(patch.data, width, height, { x: 0, y: 0, width, height })
    pixels.putImageData(patch, x, y)
  }
  canvas.width = doc.crop.width; canvas.height = doc.crop.height
  contextOf(canvas).drawImage(working, doc.crop.x, doc.crop.y, doc.crop.width, doc.crop.height, 0, 0, doc.crop.width, doc.crop.height)
  working.width = 0; working.height = 0
}
function stroke(ctx: CanvasRenderingContext2D, color: string, width: number, colors: AnnotateColors): void {
  ctx.strokeStyle = colors.white; ctx.lineWidth = width + 3
  ctx.shadowColor = colors.shadow; ctx.shadowBlur = 2
  ctx.stroke()
  ctx.shadowBlur = 0; ctx.strokeStyle = color; ctx.lineWidth = width
  ctx.stroke()
}
function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, colors: AnnotateColors, markerIndex: number): void {
  if (shape.kind === 'mosaic') return
  const color = colors[shape.color]
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath()
  switch (shape.kind) {
    case 'rect': ctx.roundRect(shape.box.x, shape.box.y, shape.box.width, shape.box.height, Math.min(6, shape.box.width / 2, shape.box.height / 2)); stroke(ctx, color, shape.lineWidth, colors); break
    case 'arrow': {
      const { from, to } = shape
      const angle = Math.atan2(to.y - from.y, to.x - from.x), head = Math.max(14, shape.lineWidth * 3)
      ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); stroke(ctx, color, shape.lineWidth, colors)
      ctx.beginPath(); ctx.moveTo(to.x, to.y)
      ctx.lineTo(to.x - head * Math.cos(angle - .5), to.y - head * Math.sin(angle - .5))
      ctx.lineTo(to.x - head * Math.cos(angle + .5), to.y - head * Math.sin(angle + .5)); ctx.closePath()
      stroke(ctx, color, 2, colors); ctx.fillStyle = color; ctx.fill(); break
    }
    case 'marker':
      ctx.arc(shape.at.x, shape.at.y, shape.radius, 0, Math.PI * 2)
      stroke(ctx, color, 2, colors); ctx.fillStyle = color; ctx.fill()
      ctx.fillStyle = shape.color === 'white' ? colors.ink : colors.white
      ctx.font = `700 ${shape.radius * 1.2}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(String(markerIndex + 1), shape.at.x, shape.at.y); break
    case 'pen': {
      const points = shape.points
      if (!points.length) break
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length - 1; i++) ctx.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + points[i + 1].x) / 2, (points[i].y + points[i + 1].y) / 2)
      const last = points.at(-1)!
      ctx.lineTo(last.x + (points.length === 1 ? .1 : 0), last.y); stroke(ctx, color, shape.lineWidth, colors); break
    }
    case 'text':
      ctx.font = `600 ${shape.size}px system-ui`; ctx.textBaseline = 'top'; ctx.lineWidth = 3
      shape.text.split('\n').forEach((line, index) => {
        const y = shape.at.y + index * shape.size * 1.3
        ctx.strokeStyle = colors.white; ctx.shadowColor = colors.shadow; ctx.shadowBlur = 2; ctx.strokeText(line, shape.at.x, y); ctx.shadowBlur = 0
        ctx.fillStyle = color; ctx.fillText(line, shape.at.x, y)
      }); break
  }
  ctx.restore()
}
function drawVectors(ctx: CanvasRenderingContext2D, doc: AnnotateDocument, colors: AnnotateColors): void {
  const markers = markersOf(doc)
  ctx.save(); ctx.translate(-doc.crop.x, -doc.crop.y)
  for (const shape of doc.shapes) drawShape(ctx, shape, colors, markers.findIndex(marker => marker.id === shape.id))
  ctx.restore()
}
export function renderVectors(canvas: HTMLCanvasElement, doc: AnnotateDocument, colors: AnnotateColors, selected: string | null, scale: number, cropDraft?: Box): void {
  if (canvas.width !== doc.crop.width) canvas.width = doc.crop.width
  if (canvas.height !== doc.crop.height) canvas.height = doc.crop.height
  const ctx = contextOf(canvas)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  drawVectors(ctx, doc, colors)
  const selectedShape = doc.shapes.find(shape => shape.id === selected)
  const box = cropDraft ?? (selectedShape ? boundsOf(selectedShape) : null)
  if (!box) return
  ctx.save(); ctx.translate(-doc.crop.x, -doc.crop.y)
  ctx.strokeStyle = colors.live; ctx.lineWidth = 1.5 / scale; ctx.setLineDash([5 / scale, 4 / scale])
  ctx.strokeRect(box.x, box.y, box.width, box.height); ctx.setLineDash([])
  for (const [x, y] of [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]) {
    ctx.fillStyle = colors.white; ctx.fillRect(x - 4 / scale, y - 4 / scale, 8 / scale, 8 / scale)
    ctx.strokeRect(x - 4 / scale, y - 4 / scale, 8 / scale, 8 / scale)
  }
  ctx.restore()
}
export async function exportAnnotation(image: HTMLImageElement, doc: AnnotateDocument, colors: AnnotateColors): Promise<Blob> {
  const canvas = document.createElement('canvas')
  renderBackground(canvas, image, doc)
  drawVectors(contextOf(canvas), doc, colors)
  try {
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not export the annotated PNG')), 'image/png'))
  } finally { canvas.width = 0; canvas.height = 0 }
}

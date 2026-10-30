export type Point = { x: number; y: number }
export type Box = Point & { width: number; height: number }
export type AnnotateTool = 'rect' | 'arrow' | 'marker' | 'pen' | 'text' | 'mosaic' | 'crop'
export type AnnotateColor = 'danger' | 'warn' | 'live' | 'ok' | 'white'
type Style = { id: string; color: AnnotateColor; lineWidth: number }
export type Shape = Style & (
  | { kind: 'rect'; box: Box }
  | { kind: 'mosaic'; box: Box }
  | { kind: 'arrow'; from: Point; to: Point }
  | { kind: 'marker'; at: Point; radius: number; note: string }
  | { kind: 'pen'; points: readonly Point[] }
  | { kind: 'text'; at: Point; text: string; size: number }
)
export type Marker = Extract<Shape, { kind: 'marker' }>
export type AnnotateDocument = { width: number; height: number; crop: Box; shapes: readonly Shape[] }
export type AnnotateHistory = { past: readonly AnnotateDocument[]; present: AnnotateDocument; future: readonly AnnotateDocument[] }

export function newDocument(width: number, height: number): AnnotateDocument {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error('Invalid image dimensions')
  return { width, height, crop: { x: 0, y: 0, width, height }, shapes: [] }
}
export const newHistory = (present: AnnotateDocument): AnnotateHistory => ({ past: [], present, future: [] })
export function commit(history: AnnotateHistory, next: AnnotateDocument): AnnotateHistory {
  return next === history.present ? history : { past: [...history.past, history.present], present: next, future: [] }
}
export function undo(history: AnnotateHistory): AnnotateHistory {
  const previous = history.past.at(-1)
  return previous ? { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] } : history
}
export function redo(history: AnnotateHistory): AnnotateHistory {
  const next = history.future[0]
  return next ? { past: [...history.past, history.present], present: next, future: history.future.slice(1) } : history
}
export const boxBetween = (a: Point, b: Point): Box => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
export const inside = (point: Point, box: Box) => point.x >= box.x && point.y >= box.y && point.x <= box.x + box.width && point.y <= box.y + box.height
export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const width = Math.min(a.x + a.width, b.x + b.width) - x, height = Math.min(a.y + a.height, b.y + b.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : null
}
export function boundsOf(shape: Shape): Box {
  switch (shape.kind) {
    case 'rect': case 'mosaic': return shape.box
    case 'arrow': return boxBetween(shape.from, shape.to)
    case 'marker': return { x: shape.at.x - shape.radius, y: shape.at.y - shape.radius, width: shape.radius * 2, height: shape.radius * 2 }
    case 'text': {
      const lines = shape.text.split('\n')
      return { x: shape.at.x, y: shape.at.y, width: Math.max(1, ...lines.map(line => [...line].length)) * shape.size, height: lines.length * shape.size * 1.3 }
    }
    case 'pen': {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
      for (const p of shape.points) { left = Math.min(left, p.x); top = Math.min(top, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y) }
      return { x: left, y: top, width: right - left, height: bottom - top }
    }
  }
}
export function addShape(doc: AnnotateDocument, shape: Shape): AnnotateDocument {
  if (doc.shapes.some(candidate => candidate.id === shape.id)) throw new Error('Duplicate annotation id')
  return { ...doc, shapes: [...doc.shapes, shape] }
}
export function editShape(doc: AnnotateDocument, id: string, edit: (shape: Shape) => Shape): AnnotateDocument {
  let changed = false
  const shapes = doc.shapes.map(shape => {
    const next = shape.id === id ? edit(shape) : shape
    changed ||= next !== shape
    return next
  })
  return changed ? { ...doc, shapes } : doc
}
export function deleteShape(doc: AnnotateDocument, id: string): AnnotateDocument {
  const shapes = doc.shapes.filter(shape => shape.id !== id)
  return shapes.length === doc.shapes.length ? doc : { ...doc, shapes }
}
export const markersOf = (doc: AnnotateDocument) => doc.shapes.filter((shape): shape is Marker => shape.kind === 'marker')
export const markerLabel = (index: number) => index < 20 ? String.fromCodePoint(0x2460 + index) : `${index + 1}.`
export function annotateCaption(doc: AnnotateDocument, text: string, includeNotes = true): string {
  const notes = includeNotes ? markersOf(doc).flatMap((marker, index) => marker.note.trim() ? [`${markerLabel(index)} ${marker.note.trim()}`] : []) : []
  return [text.trim(), ...notes].filter(Boolean).join('\n')
}
export function cropDocument(doc: AnnotateDocument, area: Box): AnnotateDocument {
  const hit = intersect(doc.crop, area)
  if (!hit) return doc
  const x = Math.ceil(hit.x), y = Math.ceil(hit.y)
  const crop = { x, y, width: Math.floor(hit.x + hit.width) - x, height: Math.floor(hit.y + hit.height) - y }
  if (crop.width < 1 || crop.height < 1) return doc
  return { ...doc, crop, shapes: doc.shapes.filter(shape => shape.kind !== 'marker' || inside(shape.at, crop)) }
}

/** Transform existing vectors in original-image coordinates; raster edits stay fixed. */
export function transformShape(shape: Shape, from: Box, to: Box): Shape {
  if (shape.kind === 'mosaic') return shape
  const sx = from.width > 0 ? to.width / from.width : 1, sy = from.height > 0 ? to.height / from.height : 1
  const point = (p: Point) => ({ x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy })
  switch (shape.kind) {
    case 'rect': return { ...shape, box: to }
    case 'arrow': return { ...shape, from: point(shape.from), to: point(shape.to) }
    case 'marker': return { ...shape, at: point(shape.at), radius: shape.radius * Math.min(sx, sy) }
    case 'text': return { ...shape, at: point(shape.at), size: Math.max(1, shape.size * Math.min(sx, sy)) }
    case 'pen': return { ...shape, points: shape.points.map(point) }
  }
}
const segmentDistance = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
export function hitTest(doc: AnnotateDocument, p: Point, tolerance: number): Shape | undefined {
  return [...doc.shapes].reverse().find(shape => {
    if (shape.kind === 'mosaic') return false
    if (shape.kind === 'marker') return Math.hypot(p.x - shape.at.x, p.y - shape.at.y) <= shape.radius + tolerance
    if (shape.kind === 'arrow') return segmentDistance(p, shape.from, shape.to) <= tolerance + shape.lineWidth / 2
    if (shape.kind === 'pen') return shape.points.some((point, i) => segmentDistance(p, point, shape.points[Math.max(0, i - 1)]) <= tolerance + shape.lineWidth / 2)
    const box = boundsOf(shape)
    if (shape.kind === 'text') return inside(p, box)
    const edges = [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }]
    return edges.some((point, i) => segmentDistance(p, point, edges[(i + 1) % 4]) <= tolerance + shape.lineWidth / 2)
  })
}

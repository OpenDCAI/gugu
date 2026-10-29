import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { addShape, boundsOf, boxBetween, commit, cropDocument, deleteShape, editShape, hitTest, inside, newHistory, redo, transformShape, undo, type AnnotateColor, type AnnotateDocument, type AnnotateTool, type Box, type Point, type Shape } from './annotateModel'

type View = { zoom: number; x: number; y: number }
type Gesture =
  | { kind: 'pan'; start: Point; view: View }
  | { kind: 'pinch'; center: Point; distance: number; view: View }
  | { kind: 'shape'; base: AnnotateDocument; shape: Shape; start: Point; bounds: Box; anchor?: Point }
  | { kind: 'draw'; base: AnnotateDocument; start: Point; shape: Shape }
  | { kind: 'crop'; base: AnnotateDocument; start: Point }

const clientPoint = (event: ReactPointerEvent) => ({ x: event.clientX, y: event.clientY })
const centerOf = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const editable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input,textarea,[contenteditable="true"]')
const toolKeys: Record<string, AnnotateTool> = { r: 'rect', a: 'arrow', n: 'marker', p: 'pen', t: 'text', m: 'mosaic', c: 'crop' }

export function useAnnotateCanvas(initial: AnnotateDocument) {
  const [history, setHistory] = useState(() => newHistory(initial))
  const [draft, setDraft] = useState<AnnotateDocument | null>(null)
  const [cropDraft, setCropDraft] = useState<Box>()
  const [tool, setTool] = useState<AnnotateTool>('rect')
  const [color, setColor] = useState<AnnotateColor>('danger')
  const [lineWidth, setLineWidth] = useState(5)
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null), [noteFocus, setNoteFocus] = useState(0)
  const [editingText, setEditingText] = useState<string | null>(null)
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 })
  const [viewport, setViewport] = useState({ width: 1, height: 1 })
  const stage = useRef<HTMLDivElement>(null), vectors = useRef<HTMLCanvasElement>(null)
  const gesture = useRef<Gesture | null>(null), pointers = useRef(new Map<number, Point>()), space = useRef(false)
  const working = useRef<AnnotateDocument | null>(null)
  const doc = draft ?? history.present
  const fit = Math.max(.001, Math.min(1, (viewport.width - 32) / doc.crop.width, (viewport.height - 32) / doc.crop.height))
  const scale = fit * view.zoom
  const save = (next: AnnotateDocument) => setHistory(current => commit(current, next))
  const show = (next: AnnotateDocument) => { working.current = next; setDraft(next) }
  const resetGesture = () => { gesture.current = null; working.current = null; setDraft(null); setCropDraft(undefined) }
  const undoEdit = () => { resetGesture(); setEditingText(null); setHistory(undo) }
  const redoEdit = () => { resetGesture(); setEditingText(null); setHistory(redo) }
  const finishTextEdit = () => {
    const shape = history.present.shapes.find(candidate => candidate.id === editingText)
    const next = shape?.kind === 'text' && !shape.text.trim() ? deleteShape(history.present, shape.id) : history.present
    if (next !== history.present) save(next)
    setEditingText(null)
    return next
  }
  const chooseTool = (next: AnnotateTool) => { finishTextEdit(); setSelected(null); setTool(next) }

  useEffect(() => {
    const element = stage.current
    if (!element) return
    const resize = () => setViewport({ width: element.clientWidth, height: element.clientHeight })
    const observer = new ResizeObserver(resize)
    observer.observe(element); resize()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || editable(event.target)) return
      if (!(event.target instanceof HTMLElement) || !event.target.closest('.ia-editor') || event.target.closest('[aria-busy="true"]')) return
      const key = event.key.toLowerCase(), mod = event.metaKey || event.ctrlKey
      if (key === ' ' || (!mod && toolKeys[key]) || ['Delete', 'Backspace'].includes(event.key) || (mod && ['z', 'y', '+', '=', '-', '0'].includes(key))) {
        event.preventDefault(); event.stopPropagation()
      }
      if (key === ' ') space.current = true
      if (mod && key === 'z') { if (event.shiftKey) redoEdit(); else undoEdit() }
      else if (mod && key === 'y') redoEdit()
      else if (mod && ['+', '=', '-'].includes(key)) setView(v => ({ ...v, zoom: Math.max(.1, Math.min(32, v.zoom * (key === '-' ? .8 : 1.25))) }))
      else if (mod && key === '0') setView({ zoom: 1, x: 0, y: 0 })
      else if (!mod && toolKeys[key]) chooseTool(toolKeys[key])
      else if (selected && ['Delete', 'Backspace'].includes(event.key)) { save(deleteShape(history.present, selected)); setSelected(null) }
    }
    const keyup = (event: KeyboardEvent) => { if (event.key === ' ') space.current = false }
    const blur = () => { space.current = false }
    window.addEventListener('keydown', keydown, true); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', keydown, true); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur) }
  })
  const pointFor = (event: ReactPointerEvent): Point => {
    const box = vectors.current!.getBoundingClientRect()
    return { x: doc.crop.x + (event.clientX - box.left) / scale, y: doc.crop.y + (event.clientY - box.top) / scale }
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (editable(event.target) || !vectors.current || (event.button !== 0 && event.button !== 1)) return
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, clientPoint(event))
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      resetGesture()
      gesture.current = { kind: 'pinch', center: centerOf(a, b), distance: Math.max(1, distance(a, b)), view }
      return
    }
    if (space.current || event.button === 1) { gesture.current = { kind: 'pan', start: clientPoint(event), view }; return }
    const point = pointFor(event), base = finishTextEdit()
    if (!inside(point, base.crop)) return
    const current = base.shapes.find(shape => shape.id === selected)
    if (current && current.kind !== 'mosaic') {
      const box = boundsOf(current)
      const corners = [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, { x: box.x, y: box.y + box.height }, { x: box.x + box.width, y: box.y + box.height }]
      const corner = corners.findIndex(p => distance(p, point) < 10 / scale)
      if (corner >= 0) { gesture.current = { kind: 'shape', base, shape: current, bounds: box, start: point, anchor: corners[3 - corner] }; return }
    }
    const hit = !event.shiftKey ? hitTest(base, point, 7 / scale) : undefined
    if (hit) {
      setSelected(hit.id)
      setColor(hit.color)
      gesture.current = { kind: 'shape', base, shape: hit, bounds: boundsOf(hit), start: point }
      return
    }
    setSelected(null); setEditingText(null)
    if (tool === 'crop') { gesture.current = { kind: 'crop', base, start: point }; return }
    const style = { id: crypto.randomUUID(), color, lineWidth: lineWidth / scale }
    let shape: Shape
    switch (tool) {
      case 'rect': case 'mosaic': shape = { ...style, kind: tool, box: boxBetween(point, point) }; break
      case 'arrow': shape = { ...style, kind: tool, from: point, to: point }; break
      case 'marker': shape = { ...style, kind: tool, at: point, radius: 14 / scale, note: '' }; break
      case 'text': shape = { ...style, kind: tool, at: point, size: 24 / scale, text: '' }; break
      case 'pen': shape = { ...style, kind: tool, points: [point] }; break
    }
    gesture.current = { kind: 'draw', base, start: point, shape }
    show(addShape(base, shape))
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const action = gesture.current
    if (!action) { if (vectors.current) setHovered(hitTest(doc, pointFor(event), 7 / scale)?.id ?? null); return }
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, clientPoint(event))
    event.preventDefault(); event.stopPropagation()
    if (action.kind === 'pinch') {
      if (pointers.current.size < 2) return
      const [a, b] = [...pointers.current.values()], center = centerOf(a, b)
      const zoom = Math.max(.1, Math.min(32, action.view.zoom * distance(a, b) / action.distance))
      const box = stage.current!.getBoundingClientRect(), ratio = zoom / action.view.zoom
      setView({ zoom, x: center.x - box.left - box.width / 2 - (action.center.x - box.left - box.width / 2 - action.view.x) * ratio,
        y: center.y - box.top - box.height / 2 - (action.center.y - box.top - box.height / 2 - action.view.y) * ratio })
      return
    }
    if (action.kind === 'pan') {
      setView({ ...action.view, x: action.view.x + event.clientX - action.start.x, y: action.view.y + event.clientY - action.start.y }); return
    }
    const point = pointFor(event)
    if (action.kind === 'crop') { setCropDraft(boxBetween(action.start, point)); return }
    if (action.kind === 'shape') {
      if (!working.current && distance(point, action.start) * scale < 1) return
      const nextBox = action.anchor ? boxBetween(action.anchor, point) : { ...action.bounds, x: action.bounds.x + point.x - action.start.x, y: action.bounds.y + point.y - action.start.y }
      if (action.anchor) { nextBox.width = Math.max(1 / scale, nextBox.width); nextBox.height = Math.max(1 / scale, nextBox.height) }
      show(editShape(action.base, action.shape.id, () => transformShape(action.shape, action.bounds, nextBox))); return
    }
    let shape = action.shape
    if (shape.kind === 'pen') shape = { ...shape, points: [...shape.points, point] }
    else if (shape.kind === 'rect' || shape.kind === 'mosaic') shape = { ...shape, box: boxBetween(action.start, point) }
    else if (shape.kind === 'arrow') shape = { ...shape, to: point }
    action.shape = shape
    show(addShape(action.base, shape))
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current?.kind === 'draw' || gesture.current?.kind === 'shape') onPointerMove(event)
    pointers.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const action = gesture.current
    if (action?.kind === 'pinch') { if (!pointers.current.size) resetGesture(); return }
    if (action?.kind === 'crop') {
      save(cropDocument(action.base, boxBetween(action.start, pointFor(event))))
      setView({ zoom: 1, x: 0, y: 0 })
    } else if (action?.kind === 'draw' && working.current) {
      const shape = action.shape, box = boundsOf(shape)
      if (shape.kind === 'marker' || shape.kind === 'text' || shape.kind === 'pen' || (box.width + box.height) * scale >= 3) {
        save(working.current)
        if (shape.kind !== 'mosaic') setSelected(shape.id)
        if (shape.kind === 'marker') setNoteFocus(value => value + 1)
        if (shape.kind === 'text') setEditingText(shape.id)
      }
    } else if (action?.kind === 'shape') {
      if (working.current) save(working.current)
      if (action.shape.kind === 'marker') setNoteFocus(value => value + 1)
    }
    resetGesture()
  }
  const cancelPointer = (event: ReactPointerEvent) => { pointers.current.delete(event.pointerId); resetGesture() }
  const setStyle = (next: { color?: AnnotateColor; lineWidth?: number }) => {
    if (next.color) setColor(next.color)
    if (next.lineWidth) setLineWidth(next.lineWidth)
    if (selected) save(editShape(history.present, selected, shape => shape.kind === 'mosaic' ? shape : { ...shape, ...(next.color ? { color: next.color } : {}), ...(next.lineWidth ? { lineWidth: next.lineWidth / scale } : {}) }))
  }
  return { doc, history, stage, vectors, tool, chooseTool, color, lineWidth, selected, setSelected, hovered, setHovered, noteFocus, editingText, setEditingText, finishTextEdit, scale, view, cropDraft,
    save, undoEdit, redoEdit, setStyle, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: cancelPointer }
}

import { describe, expect, it } from 'vitest'
import { addShape, annotateCaption, boundsOf, commit, cropDocument, deleteShape, editShape, hitTest, markersOf, newDocument, newHistory, redo, transformShape, undo, type Marker, type Shape } from '../../../../apps/desktop/src/components/imageAnnotate/annotateModel'

const marker = (id: string, x: number, note: string): Marker => ({ id, kind: 'marker', at: { x, y: 10 }, radius: 14, note, color: 'danger', lineWidth: 5 })
describe('image annotation document', () => {
  it('links notes to stable marker IDs while deletion renumbers the outgoing notes', () => {
    const doc = addShape(addShape(newDocument(800, 600), marker('first', 20, 'Move this')), marker('second', 100, '  Correct color '))
    expect(annotateCaption(doc, 'Review')).toBe('Review\n① Move this\n② Correct color')
    const removed = deleteShape(doc, 'first')
    expect(markersOf(removed).map(m => m.id)).toEqual(['second'])
    expect(annotateCaption(removed, '')).toBe('① Correct color')
    expect(annotateCaption(removed, 'Review', false)).toBe('Review')
    expect(markersOf(doc)).toHaveLength(2)
  })
  it('undoes marker edits and crops together and drops redo only after a new edit', () => {
    const initial = newHistory(newDocument(800, 600))
    const marked = commit(initial, addShape(initial.present, marker('one', 20, 'Original note')))
    const edited = commit(marked, editShape(marked.present, 'one', shape => ({ ...shape, color: 'ok' })))
    const cropped = commit(edited, cropDocument(edited.present, { x: 200, y: 0, width: 200, height: 100 }))
    expect(markersOf(cropped.present)).toHaveLength(0)
    expect(undo(cropped).present).toBe(edited.present)
    expect(redo(undo(cropped)).present.crop).toEqual(cropped.present.crop)
    const changed = commit(undo(cropped), deleteShape(edited.present, 'one'))
    expect(redo(changed)).toBe(changed)
  })
  it('keeps original-resolution dimensions and clips a crop to the previous pixel region', () => {
    const doc = newDocument(6010, 4020)
    const cropped = cropDocument(doc, { x: 100.2, y: 19.1, width: 5100.6, height: 3000.5 })
    expect(cropped).toMatchObject({ width: 6010, height: 4020, crop: { x: 101, y: 20, width: 5099, height: 2999 } })
    expect(cropDocument(cropped, { x: 0, y: 0, width: 200, height: 100 }).crop).toEqual({ x: 101, y: 20, width: 99, height: 80 })
    expect(cropDocument(doc, { x: -20, y: -20, width: 1, height: 1 })).toBe(doc)
    expect(() => newDocument(0, 10)).toThrow()
  })
  it('hit-tests vectors from the top and never treats irreversible mosaic as a movable cover', () => {
    const arrow: Shape = { id: 'arrow', kind: 'arrow', from: { x: 1, y: 1 }, to: { x: 100, y: 100 }, lineWidth: 5, color: 'live' }
    const mosaic: Shape = { id: 'mosaic', kind: 'mosaic', box: { x: 0, y: 0, width: 110, height: 110 }, color: 'danger', lineWidth: 5 }
    const doc = addShape(addShape(newDocument(200, 200), arrow), mosaic)
    expect(hitTest(doc, { x: 50, y: 50 }, 2)?.id).toBe('arrow')
    expect(hitTest(doc, { x: 50, y: 10 }, 2)).toBeUndefined()
    const moved = transformShape(arrow, boundsOf(arrow), { x: 11, y: 21, width: 198, height: 198 })
    expect(moved).toMatchObject({ from: { x: 11, y: 21 }, to: { x: 209, y: 219 } })
    expect(transformShape(mosaic, boundsOf(mosaic), { x: 30, y: 30, width: 1, height: 1 })).toBe(mosaic)
  })
  it('selects the end of a CJK text line and ignores edits for missing shapes', () => {
    const text: Shape = { id: 'text', kind: 'text', at: { x: 10, y: 20 }, text: '需要改这里', size: 24, color: 'danger', lineWidth: 5 }
    const doc = addShape(newDocument(800, 600), text)
    expect(hitTest(doc, { x: 125, y: 30 }, 2)?.id).toBe('text')
    expect(editShape(doc, 'gone', shape => ({ ...shape, color: 'ok' }))).toBe(doc)
    expect(deleteShape(doc, 'gone')).toBe(doc)
    expect(commit(newHistory(doc), deleteShape(doc, 'gone')).past).toHaveLength(0)
  })
})

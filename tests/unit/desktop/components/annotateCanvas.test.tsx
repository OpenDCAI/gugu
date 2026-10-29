// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { boundsOf, newDocument } from '../../../../apps/desktop/src/components/imageAnnotate/annotateModel'
import { useAnnotateCanvas } from '../../../../apps/desktop/src/components/imageAnnotate/useAnnotateCanvas'

let editor: ReturnType<typeof useAnnotateCanvas>
let harness: ReturnType<typeof createReactHarness>
function Probe() {
  editor = useAnnotateCanvas(newDocument(800, 600))
  return <div className="ia-editor" tabIndex={0}><div ref={editor.stage} onPointerDown={editor.onPointerDown} onPointerMove={editor.onPointerMove}
    onPointerUp={editor.onPointerUp} onPointerCancel={editor.onPointerCancel}><canvas ref={editor.vectors} /></div><input aria-label="Words" /></div>
}
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { constructor(private notify: () => void) {} observe(element: HTMLElement) {
    Object.defineProperties(element, { clientWidth: { value: 432 }, clientHeight: { value: 332 } }); this.notify()
  } disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, editor.doc.crop.width * editor.scale, editor.doc.crop.height * editor.scale))
  harness = createReactHarness()
  await harness.render(createNode(Probe))
  Object.assign(editor.stage.current!, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() })
})
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })
async function pointer(type: string, x: number, y: number, id = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x * editor.scale, clientY: y * editor.scale })
  Object.defineProperty(event, 'pointerId', { value: id })
  await act(async () => editor.stage.current!.dispatchEvent(event))
}
describe('annotation canvas interaction', () => {
  it('creates one editable rectangle per drag, moves it, recolors it, and undoes the changes', async () => {
    await pointer('pointerdown', 20, 20); await pointer('pointermove', 100, 80); await pointer('pointerup', 100, 80)
    expect(editor.history.past).toHaveLength(1)
    expect(boundsOf(editor.doc.shapes[0])).toEqual({ x: 20, y: 20, width: 80, height: 60 })
    await pointer('pointerdown', 60, 20); await pointer('pointermove', 80, 30); await pointer('pointerup', 80, 30)
    expect(boundsOf(editor.doc.shapes[0])).toEqual({ x: 40, y: 30, width: 80, height: 60 })
    await act(async () => editor.setStyle({ color: 'ok' }))
    expect(editor.doc.shapes[0].color).toBe('ok')
    await act(async () => editor.undoEdit())
    expect(editor.doc.shapes[0].color).toBe('danger')
    await act(async () => editor.undoEdit())
    expect(boundsOf(editor.doc.shapes[0]).x).toBe(20)
  })
  it('cancels the first finger drawing when the second finger starts a pinch', async () => {
    await act(async () => editor.chooseTool('marker'))
    await pointer('pointerdown', 100, 100, 1)
    expect(editor.doc.shapes).toHaveLength(1)
    await pointer('pointerdown', 200, 100, 2)
    expect(editor.doc.shapes).toHaveLength(0)
    await pointer('pointermove', 300, 100, 2)
    expect(editor.view.zoom).toBeGreaterThan(1)
    await pointer('pointerup', 100, 100, 1); await pointer('pointerup', 300, 100, 2)
    expect(editor.doc.shapes).toHaveLength(0)
    expect(editor.history.past).toHaveLength(0)
  })
  it('does not commit a cancelled drawing or draw into empty space outside the image', async () => {
    await pointer('pointerdown', 20, 20); await pointer('pointermove', 100, 80); await pointer('pointercancel', 100, 80)
    expect(editor.doc.shapes).toHaveLength(0)
    await pointer('pointerdown', -20, -20); await pointer('pointerup', -20, -20)
    expect(editor.doc.shapes).toHaveLength(0)
  })
  it('runs letter shortcuts on the editor while preserving normal note input keys', async () => {
    const root = harness.container.querySelector<HTMLElement>('.ia-editor')!
    root.focus()
    await act(async () => root.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true })))
    expect(editor.tool).toBe('marker')
    const input = harness.container.querySelector('input')!
    input.focus()
    const key = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true })
    await act(async () => input.dispatchEvent(key))
    expect(editor.tool).toBe('marker')
    expect(key.defaultPrevented).toBe(false)
  })
})

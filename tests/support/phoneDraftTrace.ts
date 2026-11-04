import { readComposer } from './composerEditor'

type Entry = { seq: number; at: number; event: string; detail: unknown; stack?: string }
type Capture = { name: string; entries: Entry[]; slot: () => string }
let active: Capture | null = null
let identities = new WeakMap<object, number>()
let nextIdentity = 1
export const phoneDraftTrace = {
  begin(name: string, slot: () => string) {
    identities = new WeakMap(); nextIdentity = 1
    const capture: Capture = { name, entries: [], slot }
    active = capture
    return capture
  },
  id(value: object) {
    let id = identities.get(value)
    if (!id) { id = nextIdentity++; identities.set(value, id) }
    return id
  },
  note(event: string, detail: unknown = null, stack = false) {
    if (!active) return
    const node = document.querySelector('[data-testid="prompt-editor"]')
    let doc: string | null = null
    if (node && 'editor' in node) doc = readComposer(node)
    active.entries.push({ seq: active.entries.length, at: performance.now(), event,
      detail: { value: detail, dom: node?.textContent ?? null, doc, slot: active.slot() },
      ...(stack ? { stack: new Error(event).stack } : {}) })
  },
  observeEditor(node: Element) {
    const owner = active
    const editor = (node as HTMLElement & { editor: { on: (event: string, callback: () => void) => void } }).editor
    editor.on('transaction', () => { if (active === owner) this.note('editor.transaction', { editor: this.id(editor) }, true) })
    editor.on('update', () => { if (active === owner) this.note('editor.update', { editor: this.id(editor) }, true) })
    this.note('editor.attached', { editor: this.id(editor) })
  },
  // The caller registers this with onTestFailed; successful runs emit no trace.
  report(capture: Capture) { console.error('PHONE_DRAFT_FAILURE_TRACE', JSON.stringify(capture)) },
  end() { active = null },
}

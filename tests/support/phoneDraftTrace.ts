import { vi } from 'vitest'
import type { Editor } from '../../packages/session-ui/node_modules/@tiptap/core'
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
      detail: { value: detail, dom: node?.textContent ?? null, doc, slot: active.slot(),
        domSelection: document.getSelection()?.toString(),
        modelSelection: node && 'editor' in node ? (node as HTMLElement & { editor: Editor }).editor.state.selection.toJSON() : null },
      ...(stack ? { stack: new Error(event).stack } : {}) })
  },
  observeEditor(node: Element) {
    const owner = active
    const editor = (node as HTMLElement & { editor: Editor }).editor
    editor.on('transaction', ({ transaction }) => { if (active === owner) this.note('editor.transaction', {
      editor: this.id(editor), docChanged: transaction.docChanged, selection: transaction.selection.toJSON(),
      steps: transaction.steps.map(step => step.toJSON()),
    }, true) })
    editor.on('update', () => { if (active === owner) this.note('editor.update', { editor: this.id(editor) }, true) })
    const updateState = editor.view.updateState.bind(editor.view)
    vi.spyOn(editor.view, 'updateState').mockImplementation(state => {
      if (active === owner) this.note('view.updateState.before', { editor: this.id(editor), next: state.doc.toJSON(), selection: state.selection.toJSON() }, true)
      updateState(state)
      if (active === owner) this.note('view.updateState.after', { editor: this.id(editor) })
    })
    for (const event of ['beforeinput', 'input', 'keydown', 'keyup']) node.addEventListener(event, input => {
      if (active === owner) this.note(`dom.${event}`, { inputType: (input as InputEvent).inputType,
        selection: document.getSelection()?.toString(), key: (input as KeyboardEvent).key }, true)
    }, true)
    new MutationObserver(records => {
      if (active === owner) this.note('dom.mutation', records.map(record => ({ type: record.type,
        old: record.oldValue, removed: [...record.removedNodes].map(item => item.textContent),
        added: [...record.addedNodes].map(item => item.textContent) })))
    }).observe(node, { childList: true, subtree: true, characterData: true, characterDataOldValue: true })
    this.note('editor.attached', { editor: this.id(editor) })
  },
  // The caller registers this with onTestFailed; successful runs emit no trace.
  report(capture: Capture) { console.error('PHONE_DRAFT_FAILURE_TRACE', JSON.stringify(capture)) },
  end() { active = null },
}

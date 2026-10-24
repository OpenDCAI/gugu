import { plainTextDoc, serializeDoc } from '../../packages/session-ui/src/react/components/prompt-editor/serialize'

/** TipTap attaches its real editor to the editable DOM node. No textarea shim is involved. */
type ComposerElement = HTMLElement & { editor: {
  commands: {
    setContent(content: ReturnType<typeof plainTextDoc>, options: { emitUpdate: boolean }): void
    setTextSelection(position: number | { from: number; to: number }): void
  }
  state: { doc: Parameters<typeof serializeDoc>[0] }
} }

export function writeComposer(element: Element | null, text: string): void {
  if (!(element instanceof HTMLElement) || !('editor' in element)) throw new Error('Chat editor is not mounted')
  const editor = (element as ComposerElement).editor
  editor.commands.setContent(plainTextDoc(text), { emitUpdate: true })
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
}

export function readComposer(element: Element | null): string {
  if (!(element instanceof HTMLElement) || !('editor' in element)) throw new Error('Chat editor is not mounted')
  return serializeDoc((element as ComposerElement).editor.state.doc)
}

export function selectComposer(element: Element, from: number, to = from): void {
  (element as ComposerElement).editor.commands.setTextSelection({ from: from + 1, to: to + 1 })
}

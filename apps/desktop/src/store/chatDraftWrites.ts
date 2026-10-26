import type { PromptEditorRef } from '@gugu/session-ui/react/components'

export type DraftWrite = string | { at: 'start' | 'end'; text: string }
type DraftEditor = () => PromptEditorRef | null
type DraftStore = { drafts: Record<string, string>; setDraft: (chatId: string, update: (text: string) => string) => void }

export function appendToDraft(draft: string, text: string): string {
  return draft.trim() ? `${draft}\n${text}` : text
}

/** Programmatic writes target the live document; the store is persistence for closed composers. */
export function createDraftWriter(store: () => DraftStore) {
  const editors = new Map<string | null, Set<DraftEditor>>()
  return {
    registerDraftEditor(chatId: string | null, resolve: DraftEditor) {
      const mounted = editors.get(chatId) ?? new Set<DraftEditor>()
      const text = [...mounted].at(-1)?.()?.getText() ?? (chatId ? store().drafts[chatId] ?? '' : '')
      mounted.add(resolve)
      editors.set(chatId, mounted)
      resolve()?.setText(text)
      return () => { mounted.delete(resolve); if (!mounted.size) editors.delete(chatId) }
    },
    writeDraft(chatId: string | null | undefined, write: DraftWrite) {
      const mounted = [...editors.get(chatId ?? null) ?? []].map((resolve) => resolve()).filter((editor) => editor !== null)
      if (mounted.length) {
        for (const editor of mounted) {
          if (typeof write === 'string') editor.setText(write)
          else if (write.text) {
            const current = editor.getText()
            if (!current.trim()) editor.setText(write.text)
            else editor.insertText(write.text, write.at)
          }
        }
      } else if (chatId) {
        store().setDraft(chatId, (current) => typeof write === 'string' ? write : !write.text ? current
          : write.at === 'end' ? appendToDraft(current, write.text) : current.trim() ? `${write.text}\n${current}` : write.text)
      }
    },
  }
}

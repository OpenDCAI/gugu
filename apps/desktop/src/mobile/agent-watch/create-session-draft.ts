import { composerDrafts, NEW_SESSION_DRAFT_KEY } from '@renderer/features/sessions/composer-drafts'

type Composer = {
  getState(): { text: string }
  setText(text: string): void
  subscribe(listener: () => void): () => void
}

/** The existing creation draft follows the first sentence across device choices, within one account. */
export function mobileCreationDraftKey(ownerId: string): string {
  return `${NEW_SESSION_DRAFT_KEY}:mobile:${ownerId}`
}

export function bindCreationDraft(composer: Composer, key: string) {
  let active = true
  let submitted = false
  if (!composer.getState().text) composer.setText(composerDrafts.get(key))
  const remember = () => {
    const text = composer.getState().text
    // assistant-ui clears the composer before onNew; an in-flight first sentence still belongs to this draft.
    if (!submitted || text.length > 0) composerDrafts.set(key, text)
  }
  const unsubscribe = composer.subscribe(remember)
  return {
    hold(text: string) {
      submitted = true
      composerDrafts.set(key, text)
    },
    accepted(text: string) {
      // A newer page may already have edited the shared draft while this request was in flight.
      if (composerDrafts.get(key).trim() === text.trim()) composerDrafts.set(key, '')
      submitted = false
    },
    restore(text: string) {
      submitted = false
      if (active && !composer.getState().text) composer.setText(text)
    },
    dispose() {
      remember()
      active = false
      unsubscribe()
      composer.setText('')
    },
  }
}

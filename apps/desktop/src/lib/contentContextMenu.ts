import type { ContentContextMenu, ContentMenuItem } from '../session/shared/content-context-menu'

export const RENDERER_CONTENT_MENU_OPEN = 'gugu:content-menu-open'
let pending: { id: string; resolve: (action: string | null) => void } | null = null

/** A DOM range stays inside the renderer event; it never crosses the host IPC boundary. */
export type RendererContentContextMenu = ContentContextMenu & { selectionRange?: Range }

/** The phone's App frame uses the same content menu presenter as desktop host actions. */
export function showRendererContentMenu(items: ContentMenuItem[], position: { x: number; y: number }, selectionRange?: Range): Promise<string | null> {
  pending?.resolve(null)
  const requestId = crypto.randomUUID()
  return new Promise(resolve => {
    pending = { id: requestId, resolve }
    window.dispatchEvent(new CustomEvent<RendererContentContextMenu>(RENDERER_CONTENT_MENU_OPEN, { detail: { ...position, requestId, items, selectionRange } }))
  })
}

export function finishRendererContentMenu(requestId: string, actionId?: string): boolean {
  if (pending?.id !== requestId) return false
  pending.resolve(actionId ?? null)
  pending = null
  return true
}

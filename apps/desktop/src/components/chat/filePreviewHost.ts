import { createContext } from 'react'

/** A dedicated conversation can own its preview pane instead of opening a chat App. */
export const FilePreviewHost = createContext<{
  target?: HTMLElement | null
  onOpenChange?: (open: boolean) => void
  /** A file replaces this conversation's pane; Back returns to the mounted chat. */
  chatNavigation?: boolean
} | null>(null)

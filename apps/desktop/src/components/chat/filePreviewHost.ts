import { createContext } from 'react'

/** A dedicated conversation can own its preview pane instead of opening a chat App. */
export const FilePreviewHost = createContext<{
  target?: HTMLElement | null
  onOpenChange?: (open: boolean) => void
} | null>(null)

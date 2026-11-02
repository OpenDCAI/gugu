import type { BaseModalProps } from '@renderer/lib/modal/modal-provider'
import { GlobalSearch } from './global-search'

/** The desktop entry: the search panel as a modal, with this device's local tasks. */
export function GlobalSearchModal({ onClose }: BaseModalProps) {
  return <GlobalSearch tasks onClose={onClose} />
}

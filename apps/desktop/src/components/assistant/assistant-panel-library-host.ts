import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { LibraryHost } from '@/session/renderer/features/library/library-host'
import { connectionLibraryHost } from '../connections/connection-library-host'

/** Legacy assistant readers retain their context while sharing authorization mechanics. */
export function assistantPanelLibraryHost(base: LibraryHost, panel: (AssistantPanelFiles & { authorityEpoch?: string }) | undefined, prepare: (signal?: AbortSignal) => Promise<void>, loadError?: unknown): LibraryHost {
  return { ...connectionLibraryHost(base,panel,prepare,loadError,false), assistantPanel: panel,assistantPanelExpected: true,assistantPanelError: loadError }
}

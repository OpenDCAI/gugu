import type { ReactNode } from 'react'
import { readMemoryEntry,type AssistantMachine,type MemoryEntry } from '@/session/renderer/features/assistant/assistant-machine-core'
import { machineKey,usePhoneRead } from './useAssistantRead'

/** A failed preview belongs to its card; the metadata list remains readable. */
export function AssistantMemoryContent({ machine,entry,children }: {
  machine: AssistantMachine | undefined; entry: MemoryEntry;
  children: (entry: MemoryEntry,error: unknown,loading: boolean) => ReactNode;
}) {
  const read = usePhoneRead(machine && entry.contentPending ? `memory-body|${machineKey(machine)}|${entry.file}|${entry.contentRevision}` : null,
    () => readMemoryEntry(machine!,entry),'read one memory preview')
  if (!entry.contentPending) return children(entry,null,false)
  return children(read.state === 'ok' ? read.data : entry,read.state === 'error' ? read.error : read.state === 'ok' ? read.refreshError : null,read.state === 'loading')
}

import { assistantPanelRoutines } from '@/components/assistant/assistant-panel-routines'
import type { PhonePageProps } from './MobileAssistantApp'
import { machineKey, usePhoneRead } from './usePhoneRead'

/** The complete assistant schedule index is cloud-readable while its host sleeps. */
export function usePhoneRoutines({ machine }: Pick<PhonePageProps, 'assistant' | 'home' | 'homeDeviceId' | 'machine'>) {
  const ready = machine.state === 'ready' ? machine.machine : null
  const api = ready?.panel ? assistantPanelRoutines(ready.panel) : null
  const stored = usePhoneRead(api && ready ? `routines|${machineKey(ready)}` : null,() => api!.list(),'list routines')
  const read = machine.state === 'error' ? { ...stored,state: 'error' as const,error: machine.error } : stored
  return { read,routines: read.state === 'ok' ? read.data : [],directory: null,api }
}

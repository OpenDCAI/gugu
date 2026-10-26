import { assistantPanelRoutines } from '@/components/assistant/assistant-panel-routines'
import type { PhonePageProps } from './MobileAssistantApp'
import { machineKey, usePhoneRead } from './usePhoneRead'

/** The complete assistant schedule index is cloud-readable while its host sleeps. */
export function usePhoneRoutines({ machine }: Pick<PhonePageProps, 'assistant' | 'home' | 'homeDeviceId' | 'readiness' | 'machine'>) {
  const ready = machine.state === 'ready' ? machine.machine : null
  const api = ready?.panel ? assistantPanelRoutines(ready.panel) : null
  const read = usePhoneRead(api && ready ? `routines|${machineKey(ready)}` : null,() => api!.list(),'list routines')
  return { read,routines: read.state === 'ok' ? read.data : [],directory: null,api }
}

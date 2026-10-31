import { useCloudAssistantFiles } from '@/components/assistant/assistant-panel-files'
import { assistantPanelRoutines } from '@/components/assistant/assistant-panel-routines'
import type { PhonePageProps } from './MobileAssistantApp'
import { machineKey, usePhoneRead } from './usePhoneRead'

/** The complete assistant schedule index is cloud-readable while its host sleeps. */
export function usePhoneRoutines({ assistant, chatId, homeDeviceId, machine }: Pick<PhonePageProps, 'assistant' | 'chatId' | 'home' | 'homeDeviceId' | 'machine'>) {
  const ready = machine.state === 'ready' ? machine.machine : null
  // Schedules belong to the account. A failed execution-host read must not
  // become a schedule failure when the shell can still read their cloud index.
  const cloud = useCloudAssistantFiles(assistant.id,chatId,ready?.panel ? null : homeDeviceId)
  const source = ready?.panel ? ready : cloud
  const api = source?.panel ? assistantPanelRoutines(source.panel) : null
  const stored = usePhoneRead(api && source ? `routines|${machineKey(source)}` : null,() => api!.list(),'list routines')
  const read = !source && machine.state === 'error' ? { ...stored,state: 'error' as const,error: machine.error } : stored
  return { read,routines: read.state === 'ok' ? read.data : [],directory: null,api }
}

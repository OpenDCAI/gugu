import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AssistantEmpty } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { DeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { ReadView, ReadingNow } from './PhoneMachineView'
import type { PhoneRead } from './usePhoneRead'

/** Reading computer schedules also needs the directory that identifies their creating agents. */
export function PhoneRoutineRead<T>({ read, directory, children }: {
  read: PhoneRead<T> & { reload: () => void }
  directory: DeviceSessions | null | undefined
  children: (data: T) => ReactNode
}) {
  const { t } = useTranslation('assistant')
  if (directory?.error) return <AssistantEmpty title={t('routines.loadFailed')}><span role="alert">{directory.error}</span></AssistantEmpty>
  if (read.state === 'error') return <ReadView read={read} failedTitle={t('routines.loadFailed')}>{children}</ReadView>
  if (directory !== null && (!directory || directory.loading || directory.cached)) return <ReadingNow />
  return <ReadView read={read} failedTitle={t('routines.loadFailed')}>{children}</ReadView>
}

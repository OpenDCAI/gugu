import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { DeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { ReadView } from './PhoneMachineView'
import type { PhoneRead } from './usePhoneRead'

/** Reading computer schedules also needs the directory that identifies their creating agents. */
export function PhoneRoutineRead<T>({ read, directory: _directory, children }: {
  read: PhoneRead<T> & { reload: () => void }
  directory: DeviceSessions | null | undefined
  children: (data: T) => ReactNode
}) {
  const { t } = useTranslation('assistant')
  return <ReadView read={read} failedTitle={t('routines.loadFailed')}>{children}</ReadView>
}

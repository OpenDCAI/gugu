import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from '@/lib/icons'
import { Collapse } from '../ui/Collapse'
import { SettingsRow } from '../settings/SettingsPrimitives'

/** Old registrations remain available here; returning online moves them out through the live list. */
export function DeviceMachineArchive({ count, children }: { count: number; children: ReactNode }) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!count) return null
  return <section data-testid="device-long-offline">
    <SettingsRow title={t('devices.longOffline')} data-testid="device-long-offline-toggle" aria-expanded={open} aria-controls={id}
      control={<><span className="gg-settings-row-value">{count}</span>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</>}
      onClick={() => setOpen(value => !value)} />
    <Collapse open={open} id={id}><div role="list">{children}</div></Collapse>
  </section>
}

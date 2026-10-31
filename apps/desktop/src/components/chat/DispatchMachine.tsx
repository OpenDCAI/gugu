import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDevicesStore } from '@/store/devicesContext'
import { MachinesPage } from '@/mobile/agent-watch/MachinesPage'
import { useMachineLabel } from '@/mobile/agent-watch/useMachineLabel'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'

/** The same machine picker as New task, shown only for a phone's new-agent handoff. */
export function DispatchMachine({ deviceId, onPick }: { deviceId: string | null; onPick: (id: string) => void }) {
  const { t } = useTranslation('main')
  const { devices } = useDevicesStore()
  const { label } = useMachineLabel()
  const [choosing, setChoosing] = useState(false)
  const device = devices.find((one) => one.device_id === deviceId)
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setChoosing(true)} data-testid="dispatch-machine">
        {t('agentWatch.create.pickMachine')}{device ? ` · ${label(device)}` : ''}
      </Button>
      {choosing && (
        <Sheet onClose={() => setChoosing(false)} fullScreenMobile testId="dispatch-machine-picker" ariaLabel={t('agentWatch.create.pickMachine')}>
          <MachinesPage computersOnly onBack={() => setChoosing(false)} onOpenDevice={(picked) => { onPick(picked.device_id); setChoosing(false) }} />
        </Sheet>
      )}
    </>
  )
}

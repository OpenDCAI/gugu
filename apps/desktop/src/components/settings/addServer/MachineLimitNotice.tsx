import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { deviceMachines } from '@gugu/core/shared/deviceMachines'
import { currentMachineLimitRefusal } from '../../../lib/device-labels'
import { messageForUser } from '../../../lib/userFacingError'
import { useDevicesStore } from '../../../store/devicesContext'
import { Button } from '../../ui/Button'
import { useDeviceRemoval } from '../useDeviceRemoval'
import { InlineAction } from './InlineAction'

function machineLimitText(t: (key: string, values?: Record<string, unknown>) => string, refusal: MachineLimitRefusal | null): string {
  if (!refusal) return t('devices.addServer.machineLimit.unknown')
  return t(`devices.addServer.machineLimit.${refusal.limit}`, { used: refusal.used, max: refusal.max })
}

export function MachineLimitNotice({
  refusal,
  onUpgrade,
  onRemoveMachine,
  onAvailable,
}: {
  refusal: MachineLimitRefusal | null
  onUpgrade?: () => void
  onRemoveMachine?: () => void
  onAvailable?: () => void
}) {
  const { t } = useTranslation('settings')
  const { devices, phones } = useDevicesStore()
  const endpoints = useMemo(() => [...devices, ...(phones ?? [])], [devices, phones])
  const machines = useMemo(() => deviceMachines(endpoints), [endpoints])
  const { openRemoveDevices, dialogs } = useDeviceRemoval(machines)
  const [reading, setReading] = useState<{ source: typeof refusal; value: typeof refusal; error: string } | null>(null)
  const [retry, setRetry] = useState(0)
  // Device removal already refreshes the store. Read the same enforcement RPC
  // after every change, including a partial removal of a multi-version machine.
  useEffect(() => {
    if (!refusal?.machine_id || !refusal.via) return
    let live = true
    void currentMachineLimitRefusal({ machine_id: refusal.machine_id, via: refusal.via }).then(
      (value) => { if (live) setReading({ source: refusal, value, error: '' }) },
      (error) => { if (live) setReading({ source: refusal, value: refusal, error: messageForUser(error) }) },
    )
    return () => { live = false }
  }, [refusal, devices, phones, retry])
  const result = reading?.source === refusal ? reading : null
  const current = result ? result.value : refusal
  const error = result?.error
  const available = result !== null && current === null && !error

  return (
    <div data-testid="add-server-machine-limit">
      <div>
        {available ? t('devices.addServer.machineLimit.available') : machineLimitText(t, current)}
        {!available && (onUpgrade || onRemoveMachine) && (
          <>
            {' '}
            {onUpgrade && (
              <InlineAction onClick={onUpgrade} testId="add-server-machine-limit-upgrade">
                {t('devices.addServer.machineLimit.upgrade')}
              </InlineAction>
            )}
            {onUpgrade && onRemoveMachine && t('devices.addServer.machineLimit.or')}
            {onRemoveMachine && (
              <InlineAction onClick={onRemoveMachine} testId="add-server-machine-limit-remove">
                {t('devices.addServer.machineLimit.remove')}
              </InlineAction>
            )}
            {t('devices.addServer.machineLimit.end')}
          </>
        )}
        {available && onAvailable && <>{' '}<InlineAction onClick={onAvailable}>{t('devices.addServer.machineLimit.continue')}</InlineAction></>}
      </div>
      {error ? (
        <div role="alert" className="mt-2 text-[var(--danger-fg)]">
          {error}{' '}<InlineAction onClick={() => setRetry((value) => value + 1)}>{t('devices.retry')}</InlineAction>
        </div>
      ) : current?.machines && current.machines.length > 0 && (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0" aria-label={t('devices.addServer.machineLimit.occupants')}>
          {current.machines.map((machine) => (
            <li key={machine.machine_id} className="flex items-center justify-between gap-3" data-machine-id={machine.machine_id}>
              <span className="min-w-0 truncate">{machine.label}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={machine.device_ids.some((id) => !endpoints.some((device) => device.device_id === id))}
                onClick={() => openRemoveDevices(machine.device_ids)}
                aria-label={t('devices.remove.label', { name: machine.label })}
              >
                {t('devices.remove.confirm')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {dialogs}
    </div>
  )
}

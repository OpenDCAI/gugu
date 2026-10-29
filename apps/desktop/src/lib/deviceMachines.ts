import { partitionDeviceMachines, type DeviceMachine } from '@gugu/core/shared/deviceMachines'
import { useEffect, useState } from 'react'

/** Also age an open list across the seven-day boundary, without waiting for a heartbeat. */
export function useDeviceMachineSections(machines: readonly DeviceMachine[]) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return partitionDeviceMachines(machines, now)
}

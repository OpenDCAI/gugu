import { useEffect } from 'react'
import { platform } from '@/platform'
import { getRendererSession } from '@/lib/sessionPublication'
import { machineSessionListClient } from '@/session/renderer/features/remote-hosts/machine-session-list'
import { startSessionListSync } from '@/session/shared/remote-sessions/session-list-sync'
import { removeDeviceSessions, updateDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

/** The remote-hosts store owns remote computers; the signed-in shell owns its local directory. */
export function useLocalSessionDirectory(accountId: string, deviceId: string | undefined): void {
  useEffect(() => {
    if (platform.kind !== 'electron' || !deviceId) return
    let active = true
    const valid = () => active && getRendererSession()?.user.id === accountId
    const sync = startSessionListSync(machineSessionListClient, 'local', {
      onList: result => { if (valid()) updateDeviceSessions(deviceId, { ...result, cached: false, connected: true }) },
      onLoading: loading => { if (valid()) updateDeviceSessions(deviceId, { loading }) },
      onError: error => { if (valid()) updateDeviceSessions(deviceId, { error }) },
    })
    return () => { active = false; sync.stop(); removeDeviceSessions(deviceId) }
  }, [accountId, deviceId])
}

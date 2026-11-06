import { platform } from '../platform'
import { sessionCoordinator } from './sessionCoordinator'

/** Desktop sign-out also restarts the process: module state and native library connections
 * belong to the old account and cannot safely be reused by the next sign-in. */
export async function logoutAndRelaunch(): Promise<{ success: boolean }> {
  const result = await sessionCoordinator.logout()
  if (result.success && platform.capabilities.appRelaunch) await platform.relaunchApp()
  return result
}

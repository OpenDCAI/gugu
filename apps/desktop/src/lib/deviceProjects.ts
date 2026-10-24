// #113 账号上记着的每台机器的项目(从 chat.ts 拆出,chat.ts 有体量门禁)。
import { listDeviceProjects, type DeviceProject, type DeviceProjectsTableClient } from '@gugu/core/cloud/deviceProjects'
import { getCurrentAuthUserId, identityDb } from './supabase'

/** deviceId → 那台机器记在账号上的项目。读不到就抛(由设备列表那一侧留着上一份)。 */
export async function listMyDeviceProjects(): Promise<Record<string, DeviceProject[]>> {
  // @@@supabase-boundary narrow - identity.device_projects(只有本人读得到)。
  return listDeviceProjects(identityDb as unknown as DeviceProjectsTableClient, await getCurrentAuthUserId())
}

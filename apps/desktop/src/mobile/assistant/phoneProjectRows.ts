import type { Device } from '@gugu/core/shared/types/chat'
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject'
import { isAssistantHome } from '@/lib/assistantHome'
import { EMPTY_MACHINE_HOME_LAYOUT } from '@/session/renderer/features/remote-hosts/machine-home'
import { projectGroupLayout, foldProjectGroups } from '@/session/renderer/features/projects/stores/project-group-layout'
import { isImplicitSessionHomeProjectId } from '@/session/shared/core/projects/session-home-project'

export type PhoneProjectEntry = DeviceProject & { id: string; deviceId: string; label: string }

/**
 * The same project-chat grouping as the sidebar, using already published account metadata.
 * #1629 parity: projects that live on the personal assistant's own host are the assistant's home, not the
 * person's projects, so the list leaves them out. Host identity is the device row (same rule as the desktop
 * sidebar), never the project name. Presentation only: device_projects rows are not changed or deleted.
 */
export function phoneProjectRows(records: Record<string, DeviceProject[]>, devices: readonly Device[], cloudDeviceId: string | null): PhoneProjectEntry[] {
  const byDevice = new Map(devices.map(device => [device.device_id,device]))
  const assistantHost = (deviceId: string) => { const device = byDevice.get(deviceId); return device ? isAssistantHome(device,cloudDeviceId) : deviceId === cloudDeviceId }
  const rows = Object.entries(records).filter(([deviceId]) => !assistantHost(deviceId)).flatMap(([deviceId,projects]) => projects.filter(project => !isImplicitSessionHomeProjectId(project.localProjectId)).map(project => ({ ...project,deviceId,id: `${deviceId}/${project.localProjectId}` })))
  const byId = new Map(rows.map(row => [row.id,row]))
  const groups = projectGroupLayout(rows.map(row => { const device = byDevice.get(row.deviceId); return { id: row.id,machine: device?.is_current_device ? null : row.deviceId,online: device?.is_online === true,createdAt: row.createdAt } }),id => byId.get(id)?.chatId ?? undefined)
  const layout = foldProjectGroups(EMPTY_MACHINE_HOME_LAYOUT,groups)
  return rows.filter(row => !layout.rowOf.has(row.id)).map(row => ({ ...row,
    label: row.name,
    folders: [row,...rows.filter(other => layout.rowOf.get(other.id) === row.id)].flatMap(member => member.folders),
  }))
}

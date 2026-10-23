import { nativePhoneActions, type PhoneRuntimePermission, type PhoneSettingsTarget } from './nativePhoneActions'
import { missingRequirements, type PhoneActionGroup, type PhoneOsState, type PhoneRequirement } from './phoneActionCatalog'
import { nativePhoneData, phoneDataAllowed } from './phoneDataActions'
import { connectPhoneActionGroupChoice, setPhoneActionGroup } from './phoneDeviceSettings'

const RUNTIME: readonly PhoneRuntimePermission[] = ['calendar', 'contacts', 'location']
const isRuntime = (requirement: PhoneRequirement): requirement is PhoneRuntimePermission =>
  (RUNTIME as readonly string[]).includes(requirement)

export async function openPhonePermissionSettings(target: PhoneSettingsTarget): Promise<void> {
  await nativePhoneActions.openSettings({ target })
}

/** Shared by the device settings and installation guide. Never called merely by mounting a page. */
export async function requestPhoneRequirement(requirement: PhoneRequirement, os: PhoneOsState | null): Promise<void> {
  if (requirement === 'sms' || requirement === 'recordings' || requirement === 'photos') {
    const data = await nativePhoneData.request({ group: requirement })
    if (!phoneDataAllowed(requirement, data)) await openPhonePermissionSettings('app')
  } else if (isRuntime(requirement)) {
    if (os?.runtime[requirement] === 'denied') await openPhonePermissionSettings('app')
    else await nativePhoneActions.requestPermissions({ permissions: [requirement] })
  } else if (requirement === 'health_connect') {
    const status = await nativePhoneActions.healthRequest()
    if (status.granted_types.length === 0) await openPhonePermissionSettings('health')
  } else if (requirement === 'notification_listener') await openPhonePermissionSettings('notification_listener')
  else if (requirement === 'dnd_access') await openPhonePermissionSettings('dnd')
}

/** Enabling the shared device master requires the explicit per-category action in the guide. */
export async function connectPhoneActionGroup(
  ownerId: string,
  group: PhoneActionGroup,
  os: PhoneOsState | null,
  options: { enableDevice?: boolean } = {},
): Promise<void> {
  if (!os) throw new Error('还没有读到系统权限，请刷新后再试。')
  if (options.enableDevice) connectPhoneActionGroupChoice(ownerId, group)
  else setPhoneActionGroup(ownerId, group, true)
  const missing = missingRequirements(group, os)
  for (const requirement of missing.filter(isRuntime)) await requestPhoneRequirement(requirement, os)
  const special = missing.find((requirement) => !isRuntime(requirement))
  if (special) await requestPhoneRequirement(special, os)
}

import { readDeviceSshTarget } from '../shared/ui/deviceSettingsModels'
import type { SettingsTableClient } from './userSettings'

// @@@one-ssh-write-path - The per-device ssh_target lives in the same identity.user_settings device-scope

export type { SettingsTableClient }

export { readDeviceSshTarget }

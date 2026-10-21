import type { AttachmentInstallRefused } from '../../session/shared/extensions/attachment-install'
import type { ExtensionOrigin } from '../../session/shared/extensions/upgrade'
import { translateSessionMessage as t } from '../../session/renderer/localization/locale-store'

const KIND = {
  market: 'extensions.installedHereMarket',
  preinstalled: 'extensions.installedHerePreinstalled',
  folder: 'extensions.installedHereFolder',
} as const

/**
 * E-05, as the person reads it: which App is installed (where it came from, at what version), on this device or the
 * machine named. The one wording for a card that cannot offer an update and for an install that was refused.
 */
export function installedHereLine(from: ExtensionOrigin | undefined, version: string, machine?: string): string {
  const where = machine ? t('extensions.installedWhereOn', { machine }) : t('extensions.installedWhereHere')
  return t(from && from !== 'attachment' ? KIND[from] : 'extensions.installedHereUnknown', { where, version })
}

/** An install refused by E-05 (`AttachmentInstallRefused`): what is there, and that a chat's package cannot replace it. */
export function refusedLine(answer: AttachmentInstallRefused, machine?: string): string {
  return `${installedHereLine(answer.from, answer.installedVersion, machine)}${t('extensions.chatCannotReplace')}`
}

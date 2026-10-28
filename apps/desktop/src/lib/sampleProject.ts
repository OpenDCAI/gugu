import { readUserSettingsConfig, writeUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { rendererLogger } from './log'
import { identityDb } from './supabase'

// The sample project (#709) is bundled content: no project, folder, group, message or agent rows exist
// for it. This one account key is the only thing that decides whether it is shown. Only the new
// first-run intro writes it, so accounts that existed before never get the sample; a dismissal keeps
// the key, so the sample never comes back on any device.
export type SampleProjectState = { version: 1; dismissed: boolean }
const KEY = 'sampleProject'
const client = identityDb as unknown as SettingsTableClient
const log = rendererLogger('sample-project')
const listeners = new Set<(userId: string) => void>()

export function parseSampleProject(config: Record<string, unknown>): SampleProjectState | null {
  const value = config[KEY]
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sample project state')
  const { version, dismissed } = value as Record<string, unknown>
  if (version !== 1 || typeof dismissed !== 'boolean') throw new Error('Invalid sample project state')
  return { version: 1, dismissed }
}

/** Read failures propagate: the caller shows no sample and logs, ❌ guesses either way. */
export async function readSampleProjectShown(userId: string): Promise<boolean> {
  const state = parseSampleProject(await readUserSettingsConfig(client, userId, 'user'))
  return state !== null && !state.dismissed
}

/** The main window is already mounted under the intro, so whoever shows the sample re-reads on change. */
export function subscribeSampleProject(listener: (userId: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Called when the first-run intro is left, after first-run hints are enrolled. Retrying the intro keeps
 * the existing key. Never throws: a failure only costs this account its sample project and must not
 * keep the person out of the app.
 */
export async function enrollSampleProject(userId: string): Promise<void> {
  try {
    const config = await readUserSettingsConfig(client, userId, 'user')
    if (parseSampleProject(config)) return
    await writeUserSettingsConfig(client, userId, 'user', { ...config, [KEY]: { version: 1, dismissed: false } })
  } catch (error) {
    log.error({ error: String(error) }, 'enroll sample project failed')
    return
  }
  for (const listener of listeners) listener(userId)
}

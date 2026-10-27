import { readUserSettingsConfig, writeUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { identityDb } from './supabase'

// Same account row as the profile and first-run engine choice. Device-specific copy shares
// these three meanings, so using an entry on one device also retires its hint elsewhere.
export const FIRST_RUN_HINTS = ['assistant', 'collaboration'] as const
// Hints taken out of the product; a saved dismissal of one still reads, and is dropped.
const RETIRED_HINTS: readonly unknown[] = ['topics']
export type FirstRunHintId = (typeof FIRST_RUN_HINTS)[number]
export type FirstRunHintsProgress = { version: 1; dismissed: FirstRunHintId[] }
const KEY = 'firstRunHints'
const client = identityDb as unknown as SettingsTableClient

export function parseFirstRunHints(config: Record<string, unknown>): FirstRunHintsProgress | null {
  const value = config[KEY]
  // Existing accounts have no record: contextual onboarding is only enrolled by the new intro.
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid first-run hint progress')
  const { version, dismissed } = value as Record<string, unknown>
  if (version !== 1 || !Array.isArray(dismissed) || !dismissed.every((id) => FIRST_RUN_HINTS.includes(id) || RETIRED_HINTS.includes(id))) {
    throw new Error('Invalid first-run hint progress')
  }
  return { version: 1, dismissed: [...new Set(dismissed.filter((id): id is FirstRunHintId => FIRST_RUN_HINTS.includes(id)))] }
}

export async function readFirstRunHints(userId: string): Promise<FirstRunHintsProgress | null> {
  return parseFirstRunHints(await readUserSettingsConfig(client, userId, 'user'))
}

/** Enroll before finish_first_run: a failed completion remains at the intro, with progress intact. */
export async function startFirstRunHints(userId: string): Promise<void> {
  const config = await readUserSettingsConfig(client, userId, 'user')
  const progress = parseFirstRunHints(config)
  if (progress) return
  await writeUserSettingsConfig(client, userId, 'user', { ...config, [KEY]: { version: 1, dismissed: [] } })
}

/** Re-read before merging, preserving the other settings and previously retired hints. */
export async function dismissFirstRunHints(userId: string, ids: readonly FirstRunHintId[]): Promise<FirstRunHintsProgress> {
  const config = await readUserSettingsConfig(client, userId, 'user')
  const progress = parseFirstRunHints(config)
  if (!progress) throw new Error('First-run hint progress is missing')
  const next: FirstRunHintsProgress = { version: 1, dismissed: [...new Set([...progress.dismissed, ...ids])] }
  await writeUserSettingsConfig(client, userId, 'user', { ...config, [KEY]: next })
  return next
}

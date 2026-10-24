import { readUserSettingsConfig, writeUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { identityDb } from './supabase'

export type ProductTourPosition = { phase: 'modules' | 'features'; index: number }
const KEY = 'productTour'
const client = identityDb as unknown as SettingsTableClient

/** Missing means a new tour; malformed progress must not silently restart somebody's tour. */
export function parseProductTourPosition(config: Record<string, unknown>): ProductTourPosition | null {
  const value = config[KEY]
  if (value === undefined) return null
  if (!value || typeof value !== 'object') throw new Error('Invalid product tour progress')
  const { version, phase, index } = value as Record<string, unknown>
  if (version !== 1 || (phase !== 'modules' && phase !== 'features') || !Number.isInteger(index) || typeof index !== 'number' || index < 0 || index >= (phase === 'modules' ? 7 : 4)) {
    throw new Error('Invalid product tour progress')
  }
  return { phase, index }
}

export async function saveProductTourPosition(userId: string, position: ProductTourPosition): Promise<void> {
  const config = await readUserSettingsConfig(client, userId, 'user')
  await writeUserSettingsConfig(client, userId, 'user', { ...config, [KEY]: { version: 1, ...position } })
}

export function nextProductTourPosition(position: ProductTourPosition): ProductTourPosition | null {
  if (position.phase === 'modules') return position.index < 6 ? { phase: 'modules', index: position.index + 1 } : { phase: 'features', index: 0 }
  return position.index < 3 ? { phase: 'features', index: position.index + 1 } : null
}

export function previousProductTourPosition(position: ProductTourPosition): ProductTourPosition | null {
  if (position.index > 0) return { ...position, index: position.index - 1 }
  return position.phase === 'features' ? { phase: 'modules', index: 6 } : null
}

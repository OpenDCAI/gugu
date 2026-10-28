import { readUserSettingsConfig, writeUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { identityDb } from './supabase'

export type ProductTourPosition = { phase: 'modules' | 'features'; index: number }
/** The feature films, in order. The «modes» film (General / Chat / Coding) went with that switch in #639. */
export const PRODUCT_TOUR_FEATURES = ['split', 'contacts', 'report'] as const
const MODULE_COUNT = 7
const FEATURE_COUNT = PRODUCT_TOUR_FEATURES.length
/** Version 1 counted four films; its index is mapped onto the films still shown, so a resumed tour lands on the same film or the next one. */
const V1_FEATURE_INDEX = [0, 1, 1, 2]
const KEY = 'productTour'
const client = identityDb as unknown as SettingsTableClient

/** Missing means a new tour; malformed progress must not silently restart somebody's tour. */
export function parseProductTourPosition(config: Record<string, unknown>): ProductTourPosition | null {
  const value = config[KEY]
  if (value === undefined) return null
  if (!value || typeof value !== 'object') throw new Error('Invalid product tour progress')
  const { version, phase, index } = value as Record<string, unknown>
  if ((version !== 1 && version !== 2) || (phase !== 'modules' && phase !== 'features') || !Number.isInteger(index) || typeof index !== 'number' || index < 0) {
    throw new Error('Invalid product tour progress')
  }
  if (phase === 'modules') {
    if (index >= MODULE_COUNT) throw new Error('Invalid product tour progress')
    return { phase, index }
  }
  const mapped = version === 1 ? V1_FEATURE_INDEX[index] : index
  if (mapped === undefined || mapped >= FEATURE_COUNT) throw new Error('Invalid product tour progress')
  return { phase, index: mapped }
}

export async function saveProductTourPosition(userId: string, position: ProductTourPosition): Promise<void> {
  const config = await readUserSettingsConfig(client, userId, 'user')
  await writeUserSettingsConfig(client, userId, 'user', { ...config, [KEY]: { version: 2, ...position } })
}

export function nextProductTourPosition(position: ProductTourPosition): ProductTourPosition | null {
  if (position.phase === 'modules') return position.index < MODULE_COUNT - 1 ? { phase: 'modules', index: position.index + 1 } : { phase: 'features', index: 0 }
  return position.index < FEATURE_COUNT - 1 ? { phase: 'features', index: position.index + 1 } : null
}

export function previousProductTourPosition(position: ProductTourPosition): ProductTourPosition | null {
  if (position.index > 0) return { ...position, index: position.index - 1 }
  return position.phase === 'features' ? { phase: 'modules', index: MODULE_COUNT - 1 } : null
}

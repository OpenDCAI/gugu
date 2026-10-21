/**
 * agentJoinUtils — pure helpers for AgentJoinPage.
 * No React imports; safe for react-refresh fast path.
 * #900 Agent 公开 Join 落地页
 */

import { AGENT_CATEGORY_LABEL, isAgentCategory } from '@gugu/core/shared/enums/agentCategories'

/**
 * Resolve a human-readable category label from a raw string.
 * Returns null if the value is absent or not a known category.
 */
export function resolveCategoryLabel(category: string | null | undefined): string | null {
  if (!category) return null
  if (isAgentCategory(category)) return AGENT_CATEGORY_LABEL[category]
  return null
}

/**
 * Trim and clamp bio to a reasonable preview length.
 * Full bio is shown by the component; this is used for the meta description.
 */
export function clampBio(bio: string | null | undefined, maxChars = 120): string {
  if (!bio) return ''
  const trimmed = bio.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}…`
}

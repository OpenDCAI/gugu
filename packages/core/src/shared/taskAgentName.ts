/** A task and its linked identity share this name contract. */
export const MAX_TASK_AGENT_NAME_GRAPHEMES = 40
export const MAX_AUTOMATIC_TASK_AGENT_NAME_GRAPHEMES = 20

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function taskAgentNameLength(name: string): number {
  return [...segments.segment(name)].length
}

export function taskAgentName(value: string, automatic = false): string {
  const name = value.trim()
  const maximum = automatic ? MAX_AUTOMATIC_TASK_AGENT_NAME_GRAPHEMES : MAX_TASK_AGENT_NAME_GRAPHEMES
  if (!name || taskAgentNameLength(name) > maximum) {
    throw new Error(`Task agent name must contain 1–${maximum} graphemes`)
  }
  return name
}

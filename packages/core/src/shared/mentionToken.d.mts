export interface MentionSpan {
  start: number
  end: number
  name: string
}

export function findMentionSpans(text: string, names: readonly string[], options?: { ignoreCase?: boolean }): MentionSpan[]
export function hasDomainTail(value: string): boolean

export type HardcodedCjkCategory = 'user-visible' | 'developer' | 'false-positive'

export interface HardcodedCjkRow {
  file: string
  line: number
  column: number
  kind: string
  text: string
  category: HardcodedCjkCategory
  reason: string
}

export interface HardcodedCjkAudit {
  total: number
  categories: Record<HardcodedCjkCategory, number>
  fileDistribution: Record<HardcodedCjkCategory, Record<string, number>>
  rows: HardcodedCjkRow[]
}

export function auditHardcodedCjk(root?: string): HardcodedCjkAudit

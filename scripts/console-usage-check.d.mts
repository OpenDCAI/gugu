export interface ConsoleUsageEntry {
  rule: 'console-member'
  file: string
  count: number
}

export interface ConsoleUsageCount {
  entries: ConsoleUsageEntry[]
  total: number
  scanned: number
  roots: string[]
}

export function countTree(
  ref: string,
  rootArgs: string | string[],
  rootDirectory?: string,
): ConsoleUsageCount

export function compareToBaseline(
  actualEntries: ConsoleUsageEntry[],
  baselineEntries: ConsoleUsageEntry[],
): {
  added: Array<ConsoleUsageEntry & { baselineCount: number }>
  stale: Array<ConsoleUsageEntry & { actualCount: number }>
}

export function run(
  argv: string[],
  output?: Pick<Console, 'log' | 'error'>,
): number

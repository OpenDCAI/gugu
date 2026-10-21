export type UserCopyLeakRule = 'copy-leaks-internal-detail' | 'copy-leaks-raw-error-slot' | 'copy-leaks-raw-error-field'

export interface UserCopyLeakEntry {
  rule: UserCopyLeakRule
  file: string
  count: number
}

export interface UserCopyLeakCount {
  entries: UserCopyLeakEntry[]
  total: number
  scanned: number
  roots: string[]
}

/** 一个文件里三条规则各自的条数。 */
export interface UserCopyLeakSourceCount {
  catalog: number
  slot: number
  field: number
}

export function countSource(source: string, file: string): UserCopyLeakSourceCount

export function countTree(ref: string, rootArgs: string | string[], rootDirectory?: string): UserCopyLeakCount

export function compareToBaseline(
  actualEntries: UserCopyLeakEntry[],
  baselineEntries: UserCopyLeakEntry[],
): {
  added: Array<UserCopyLeakEntry & { baselineCount: number }>
  stale: Array<UserCopyLeakEntry & { actualCount: number }>
}

export function run(argv: string[], output?: Pick<Console, 'log' | 'error'>): number

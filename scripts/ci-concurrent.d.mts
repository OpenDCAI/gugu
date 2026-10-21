export interface ConcurrentJob {
  label: string
  command: string
}

export interface ConcurrentResult {
  label: string
  code: number
  signal: NodeJS.Signals | null
  seconds: number
}

export function parseJobs(argv: string[]): ConcurrentJob[]

export function runConcurrent(
  jobs: ConcurrentJob[],
  options?: { write?: (line: string) => void; env?: NodeJS.ProcessEnv },
): Promise<ConcurrentResult[]>

export function summarize(results: ConcurrentResult[]): { ok: boolean; failed: string[]; text: string }

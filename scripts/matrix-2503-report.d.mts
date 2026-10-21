export type MatrixCellKind = 'chain' | 'context' | 'byok' | 'human'

export interface MatrixChain {
  id: string
  model: string
  multiplier: number
}

export interface ExpectedMatrixCell {
  chain: string
  cell: string
  model: string
  kind: MatrixCellKind
}

export interface MatrixGate {
  status: string
  head: string
  logPath: string
}

export interface MatrixRunManifest {
  format: string
  commit: string
  startedAt: string
  finishedAt: string
  workers: number
  retries: number
  deviations: unknown[]
  allowedRejections: unknown[]
  cost: {
    upstreamUsdSpent: number
    subscriptionWindowPercentUsed: number
    beforePath: string
    afterPath: string
  }
  mutationProofs: Array<{ defect: number, path: string }>
  gates: Record<string, MatrixGate>
}

export interface MatrixEvidenceRecord {
  chain: string
  cell: string
  model: string
  verdict: 'pass' | 'fail' | 'waived'
  commit: string
  sourcePath: string
  observations: Record<string, unknown>
  waiver?: string
  [key: string]: unknown
}

export interface MatrixValidation {
  root: string
  head: string
  manifest: MatrixRunManifest
  manifestPath: string
  cells: Array<{
    expected: ExpectedMatrixCell
    record: MatrixEvidenceRecord
    artifacts: string[]
  }>
  manifestEvidence: {
    costFiles: string[]
    mutationFiles: string[]
    gateFiles: string[]
    startedAt: number
    finishedAt: number
  }
}

export const MATRIX_CHAINS: MatrixChain[]
export const HUMAN_STEPS: string[]
export const EXPECTED_CELLS: ExpectedMatrixCell[]

export function validateEvidence(input: { evidenceDir: string, head: string }): MatrixValidation
export function renderReport(validation: MatrixValidation, outputPath: string): string
export function generateReport(input: { evidenceDir: string, output: string, head: string }): {
  outputPath: string
  cells: number
  head: string
}

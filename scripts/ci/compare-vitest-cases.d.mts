export interface CaseReport {
  success: boolean
  numFailedTests: number
  numFailedTestSuites: number
  numTotalTests: number
  testResults: {
    name: string
    status: string
    assertionResults: { fullName: string; status: string }[]
  }[]
}

export interface CaseInventory {
  cases: Map<string, number>
  files: string[]
  statuses: Record<string, number>
  healthy: boolean
  reports: number
}

export interface InventorySummary {
  reports: number
  files: number
  statuses: Record<string, number>
  healthy: boolean
}

export function caseInventory(reports: readonly CaseReport[], root: string): CaseInventory
export function compareCaseInventories(baseline: CaseInventory, candidate: CaseInventory): {
  equal: boolean
  healthy: boolean
  sameFiles: boolean
  sameCases: boolean
  sameSkips: boolean
  baseline: InventorySummary
  candidate: InventorySummary
  changes: { id: [string, string]; status: string; baseline: number; candidate: number }[]
}

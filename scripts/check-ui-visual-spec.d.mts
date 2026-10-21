export interface GeometryDebtCounts {
  inlineFontSizeLiterals: number
  inlineRadiusLiterals: number
  rawButtons: number
  inlineStyleBlocks: number
}

export interface MobileShellReference {
  file: string
  line: number
  column: number
  token: string
}

export interface BannedTypeHit {
  file: string
  line: number
  column: number
  id: string
  token: string
}

export interface UiVisualSpecInspection {
  /** assistantUi = vendored 的 components/assistant-ui,自己一本账,❌ 不并进 mainRenderer。 */
  counts: { sessionRenderer: number; mainRenderer: number; assistantUi: number }
  geometryDebt: GeometryDebtCounts
  assistantUiGeometryDebt: GeometryDebtCounts
  bannedTypeHits: BannedTypeHit[]
  mobileShellReferences: MobileShellReference[]
  /** 手转图标(`animate-spin`)按文件计数;只列 >0 的文件。 */
  handRotatedSpinners: Record<string, number>
  scannedFiles: {
    sessionRenderer: number
    mainRenderer: number
    sessionUi: number
    assistantUi: number
  }
}

export function inspect(root?: string): UiVisualSpecInspection
export function run(output?: { log: (message: string) => void; error: (message: string) => void }): number

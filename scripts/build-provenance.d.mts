export type BuildProvenanceManifest = {
  schema: 1
  source: { commit: string; dirty: boolean; fingerprint: string }
  buildTag: string | null
  testNotes: string | null
  artifacts: Record<'main' | 'preload' | 'index' | 'renderer', { path: string; sha256: string }>
  rendererScript: string
  requiredPreloadSymbol: string
}

export function validateProvenanceManifest(input: unknown): BuildProvenanceManifest

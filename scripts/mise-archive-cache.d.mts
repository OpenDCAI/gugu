export const DEFAULT_MISE_DOWNLOAD_BASE: string

export function defaultMiseCacheDir(env?: Record<string, string | undefined>): string

export function obtainMiseArchive(input: {
  cacheDir: string
  downloadBase?: string
  version: string
  asset: string
  sha256: string
  download?: (url: string, destination: string) => void
  log?: (line: string) => void
  warn?: (line: string) => void
}): string

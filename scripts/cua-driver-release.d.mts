export const CUA_DRIVER_VERSION: string
export const CUA_DRIVER_MAC_REVISION: string

export function cuaDriverArchiveInfo(key: string): { url: string; asset: string; sha256: string }

export function obtainVerifiedArchive(input: {
  url: string
  asset: string
  sha256: string
  cacheDir?: string
  download?: (url: string, destination: string) => void
  log?: (line: string) => void
  warn?: (line: string) => void
}): string

export function obtainCuaDriverArchive(key: 'darwin-universal' | 'win32-x64' | 'win32-arm64'): string

export function extractOne(archive: string, member: string, dir: string): string

export function assertPeMachine(file: string, arch: 'x64' | 'arm64'): void

export function parseCuaTools(text: string, version?: string): string

export function exportCuaTools(binary: string): string

export function copyCuaLicenses(out: string): void

export function filterIcuLocaleIndex(source: string, languages: string[]): { source: string; locales: string[] }
export function trimMobileIcu(options: { input: string; output: string; work: string; languages: string[]; version: string }): Promise<{
  version: string; languages: string[]; soname: string; symbol: string
  originalBytes: number; bytes: number; originalSha256: string; dataSha256: string; sha256: string
  retained: string[]; removed: string[]
}>

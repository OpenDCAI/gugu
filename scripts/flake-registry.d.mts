export type FlakeStatus = 'open' | 'known-risk' | 'fixed'
export interface FlakeEntry {
  test: string
  location: string
  suite: string
  status: FlakeStatus
  symptom: string
  package?: string
  issue?: number
  also?: number[]
  fixed_by?: number
  note?: string
  evidence?: string
}
export interface Resolution {
  shape: 'ci-step' | 'vitest-file' | 'vitest-name' | 'dir-location'
  verdict: 'RESOLVED' | 'EXEMPT' | 'UNRESOLVED' | 'MISSING-FILE'
  trueLine: number | null
  detail: string
}
export const REGISTRY_PATH: string
export const STATUSES: Record<FlakeStatus, { blurb: string; advice: string }>
export const MIN_QUERY_LENGTH: number
export const MIN_PROSE_QUERY_LENGTH: number
export const SEARCH_FIELDS: string[]
export const IDENTITY_FIELD: string
export function parseRegistry(text: string): FlakeEntry[]
export function loadRegistry(path?: string): FlakeEntry[]
export function classifyEntry(f: FlakeEntry): Resolution['shape']
export function splitLocation(location: string): { path: string; line: number | null }
export function resolveEntry(f: FlakeEntry, readText: (path: string) => string | null, isDir: (path: string) => boolean): Resolution
export function isPhrase(query: string): boolean
export function matchedFields(f: FlakeEntry, query: string): string[]
export function identifiesFlake(fields: string[], query: string): boolean
export function findFlakes(flakes: FlakeEntry[], query: string): FlakeEntry[]
export function findMentions(flakes: FlakeEntry[], query: string): FlakeEntry[]
export function excerpt(field: string, query: string): string

export const PRODUCTION_DB_HOST: string

export function serverChannelForDb(url: string | null | undefined): 'stable' | 'beta'

export interface EnvSlot {
  value: string
  source: string | null
}

export interface ResolvedBuildEnv {
  renderer: { url: EnvSlot; anonKey: EnvSlot }
  baked: { url: EnvSlot; anonKey: EnvSlot }
}

export type DbTarget = 'prod' | 'shared-test' | 'local'

export const DB_CONNECTION_KEYS: readonly string[]
export const DB_ENV_KEYS: readonly string[]
export const DB_OPTIONAL_KEYS: readonly string[]
export const DB_TARGETS: readonly DbTarget[]
export const ENV_REGISTRY_DIR: string

export function registryFileFor(target: string): string

export function selectTargetEnv(input?: {
  target?: string
  registryValues?: Record<string, string> | null
  localValues?: Record<string, string>
  shellEnv?: Record<string, string | undefined>
}): { injected: Record<string, string>; errors: string[]; warnings: string[] }

export function envFileOrder(mode: string): string[]
export function parseEnvFile(text: string): Record<string, string>

export function resolveBuildEnv(input?: {
  envFiles?: Array<{ name: string; values?: Record<string, string> }>
  processEnv?: Record<string, string | undefined>
  processEnvLabel?: string
}): ResolvedBuildEnv

export interface ActiveDbEnv {
  values: Record<string, string>
  source: string | null
  target: string | null
}

export function loadActiveDbEnv(rootDir: string, processEnv?: Record<string, string | undefined>): ActiveDbEnv
export function applyActiveDbEnv(rootDir?: string, env?: Record<string, string | undefined>): ActiveDbEnv

/**
 * 脚本侧共享 env 读取。取代此前十一个脚本各自抄的那份十行解析器。
 * 调用方保持 `{ ...readScriptEnv(), ...process.env }` 的优先级：文件垫底，shell 覆盖。
 */
export function readScriptEnv(
  rootDir?: string,
  env?: Record<string, string | undefined>,
): Record<string, string>

/** .env.local 已退役（一套环境一个文件）。存在即抛，附可照抄的 --migrate 命令。 */
export function assertNoLegacyEnvLocal(rootDir?: string): void

export interface AnnouncedDb {
  target: string | null
  host: string | null
  source: string | null
  line: string
}

export function announceActiveDb(
  rootDir?: string,
  env?: Record<string, string | undefined>,
  log?: (line: string) => void,
): AnnouncedDb | null
export function resetDbAnnounceForTest(): void

export const BAKE_SCAN_DIRS: readonly string[]

export function decodeJwtClaims(token: unknown): Record<string, unknown> | null
export function hostOf(url: string): string | null
export function checkTargetHost(target: string, host: string | null): string | null

export function checkBuildEnv(input: {
  renderer: { url: EnvSlot; anonKey: EnvSlot }
  baked: { url: EnvSlot; anonKey: EnvSlot }
  target?: string | null
}): { errors: string[]; warnings: string[] }

export interface BakeCandidate {
  path?: string
  text?: string
}

export function verifyDistBake(input: {
  files?: BakeCandidate[]
  expectedHost: string | null
  readText?: (file: BakeCandidate) => string | undefined
}): { hits: number; errors: string[] }

export function listBakeCandidates(dir: string, out?: BakeCandidate[]): BakeCandidate[]

export type DbTarget = 'prod' | 'shared-test' | 'local'

export interface ActiveDbEnv {
  values: Record<string, string>
  source: string | null
  target: string | null
}

export interface AnnouncedDb {
  target: string | null
  host: string | null
  source: string | null
  line: string
}

export const DB_TARGETS: readonly DbTarget[]
export const ENV_REGISTRY_DIR: string

export interface EnvRegistryRuntimeAdapter {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
  join(...paths: string[]): string
}

export interface EnvRegistryRuntime {
  loadActiveDbEnv(rootDir: string, processEnv?: Record<string, string | undefined>): ActiveDbEnv
  assertNoLegacyEnvLocal(rootDir?: string): void
  applyActiveDbEnv(rootDir?: string, env?: Record<string, string | undefined>): ActiveDbEnv
  announceActiveDb(
    rootDir?: string,
    env?: Record<string, string | undefined>,
    log?: (line: string) => void,
  ): AnnouncedDb | null
}

export function registryFileFor(target: string): string
export function parseEnvFile(text: string): Record<string, string>
export function hostOf(url: string): string | null
export function createEnvRegistryRuntime(adapter: EnvRegistryRuntimeAdapter): EnvRegistryRuntime
export function resetDbAnnounceForTest(): void

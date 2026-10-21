import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_HOME_NAME = '.gugu'

export function resolveGuguHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.GUGU_HOME
  if (explicit?.trim()) return explicit
  // @@@win-home (#34) - Windows doesn't set HOME (it uses USERPROFILE); fall back to os.homedir() so a
  const home = env.HOME?.trim() || homedir()
  if (!home) throw new Error('HOME is required to resolve GUGU_HOME')
  return join(home, DEFAULT_HOME_NAME)
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveGuguHome(env)
}

export async function ensureStateDirs(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await mkdir(stateDir(env), { recursive: true })
}

const WINDOWS_FILE_LOCK_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400] as const

export async function retryWindowsFileLock<T>(
  operation: () => Promise<T>,
  platform: NodeJS.Platform = process.platform,
  wait: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  for (let retry = 0; retry <= WINDOWS_FILE_LOCK_RETRY_DELAYS_MS.length; retry += 1) {
    try {
      return await operation()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        platform !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') ||
        retry >= WINDOWS_FILE_LOCK_RETRY_DELAYS_MS.length
      ) {
        throw error
      }
      await wait(WINDOWS_FILE_LOCK_RETRY_DELAYS_MS[retry])
    }
  }
  throw new Error('Windows file-lock retry loop exhausted unexpectedly')
}

export async function atomicWriteText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmpPath, text, 'utf8')
    await chmod(tmpPath, 0o600)
    await retryWindowsFileLock(() => rename(tmpPath, path))
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText, resolveGuguHome } from '../state/paths'
import { accessTokenExpirySeconds, refreshSupabaseSession } from '../../cloud/runtimeAuthProvider'
import { getSupabaseAnonKey, getSupabaseUrl } from '../../cloud/config'

export type HumanAuthRefreshOwner = 'desktop' | 'cli'

export interface HumanAuthSession {
  user_id: string
  email: string | null
  access_token: string
  refresh_token: string
  refresh_owner: HumanAuthRefreshOwner
  updated_at: string
}

export function humanAuthSessionFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGuguHome(env), 'auth.json')
}

export async function readHumanAuthSession(
  env: NodeJS.ProcessEnv = process.env
): Promise<HumanAuthSession | null> {
  let raw: string
  try {
    raw = await readFile(humanAuthSessionFile(env), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  try {
    return validateHumanAuthSession(JSON.parse(raw))
  } catch (error) {
    throw new Error(`Invalid Gugu human auth session: ${(error as Error).message}`)
  }
}

export async function writeHumanAuthSession(
  session: HumanAuthSession,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await atomicWriteText(humanAuthSessionFile(env), `${JSON.stringify(validateHumanAuthSession(session), null, 2)}\n`)
}

export async function clearHumanAuthSession(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await unlink(humanAuthSessionFile(env)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

export interface FreshHumanAuthDeps {
  now?: () => number
  skewSeconds?: number
  supabaseUrl?: string
  anonKey?: string
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

// @@@ cli — see git history for full context.
export async function readFreshHumanAuthSession(
  env: NodeJS.ProcessEnv = process.env,
  deps: FreshHumanAuthDeps = {}
): Promise<HumanAuthSession | null> {
  const session = await readHumanAuthSession(env)
  if (!session) return null
  if (session.refresh_owner !== 'cli') return session

  const skew = deps.skewSeconds ?? 60
  const nowSeconds = deps.now ?? (() => Date.now() / 1000)
  const exp = accessTokenExpirySeconds(session.access_token)
  if (exp !== null && exp - skew > nowSeconds()) return session

  const rotated = await refreshSupabaseSession({
    supabaseUrl: deps.supabaseUrl ?? getSupabaseUrl(),
    anonKey: deps.anonKey ?? getSupabaseAnonKey(),
    refreshToken: session.refresh_token,
    fetchImpl: deps.fetchImpl
  })
  const refreshed: HumanAuthSession = {
    ...session,
    access_token: rotated.accessToken,
    refresh_token: rotated.refreshToken,
    updated_at: new Date().toISOString()
  }
  await writeHumanAuthSession(refreshed, env)
  return refreshed
}

function validateHumanAuthSession(value: unknown): HumanAuthSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected an object')
  }
  const input = value as Record<string, unknown>
  const userId = requiredString(input.user_id, 'user_id')
  const accessToken = requiredString(input.access_token, 'access_token')
  const refreshToken = requiredString(input.refresh_token, 'refresh_token')
  const updatedAt = requiredString(input.updated_at, 'updated_at')
  const refreshOwner = input.refresh_owner
  if (refreshOwner !== 'desktop' && refreshOwner !== 'cli') {
    throw new Error('refresh_owner must be desktop or cli')
  }
  if (input.email !== null && input.email !== undefined && typeof input.email !== 'string') {
    throw new Error('email must be a string or null')
  }
  return {
    user_id: userId,
    email: input.email ?? null,
    access_token: accessToken,
    refresh_token: refreshToken,
    refresh_owner: refreshOwner,
    updated_at: updatedAt
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

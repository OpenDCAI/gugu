import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { PlatformLaunchMetadataCache } from '../../../../apps/desktop/electron/sessionpage/platform-launch-metadata'
import type { IssuedModelAccess } from '../../../../apps/desktop/electron/model-access'

const access: IssuedModelAccess = {
  accessSessionId: 'lease-id', token: 'upstream-secret', relayUrl: 'https://upstream.test',
  expiresAt: '2030-01-01T00:00:00Z', model: 'model-alias', modelId: 'model-id', protocol: 'openai-responses',
  contextWindow: 128_000, reasoningEfforts: ['low', 'high'], membershipLocked: [], callableRoutes: {},
  switchableModels: [{ id: 'model-id', alias: 'model-alias', displayName: 'Model', contextWindow: 128_000, reasoningEfforts: ['low', 'high'] }],
}

it('persists only signed launch metadata and separates the issuing accounts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-launch-metadata-'))
  try {
    const file = join(directory, 'metadata.json')
    const cache = new PlatformLaunchMetadataCache(file)
    const key = cache.key('owner-a', 'codex', 'model-id', 'openai-responses')
    cache.remember(key, access)
    const saved = await readFile(file, 'utf8')
    for (const secret of ['upstream-secret', 'lease-id', 'https://upstream.test', 'expiresAt']) expect(saved).not.toContain(secret)
    const restored = new PlatformLaunchMetadataCache(file)
    expect(restored.get(key)?.switchableModels).toEqual(access.switchableModels)
    expect(restored.get(cache.key('owner-b', 'codex', 'model-id', 'openai-responses'))).toBeUndefined()
    expect(restored.get(cache.key('owner-a', 'codex', 'model-id', 'openai-chat-completions'))).toBeUndefined()
  } finally {
    await rm(join(directory, 'metadata.json'), { force: true })
    await rmdir(directory)
  }
})

// Persistence is optional startup acceleration: at most 64 recent keys.
const maxCacheEntries = 64

async function withCacheFile(run: (file: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'platform-launch-bounds-'))
  const file = join(directory, 'metadata.json')
  try { await run(file) } finally {
    await rm(file, { force: true })
    await rmdir(directory)
  }
}

it('persists only the 64 most recently remembered account/model keys', async () => {
  await withCacheFile(async file => {
    const cache = new PlatformLaunchMetadataCache(file)
    const keys = Array.from({ length: maxCacheEntries + 1 }, (_, index) => cache.key(`owner-${index}`, 'codex', 'model', 'openai-responses'))
    for (const key of keys) cache.remember(key, access)
    const restored = new PlatformLaunchMetadataCache(file)
    expect(restored.get(keys[0]!)).toBeUndefined()
    expect(restored.get(keys.at(-1)!)?.model).toBe(access.model)
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')))).toHaveLength(maxCacheEntries)
  })
})

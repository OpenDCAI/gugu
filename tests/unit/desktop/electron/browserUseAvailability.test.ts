import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { browserUseAppInstalled } from '../../../../apps/desktop/electron/browser-agent-mcp'
import { createDesktopGuguMcpHost, type DesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'
import { BROWSER_UNAVAILABLE_RULE, buildSessionBundle, loadCodexAppServerCapabilities, setBrowserUseApp } from '../../../../apps/desktop/electron/capability-bundle'

const hosts: DesktopGuguMcpHost[] = []
afterEach(async () => {
  setBrowserUseApp(null)
  await Promise.all(hosts.splice(0).map(host => host.dispose()))
})

describe('#7199 这台机器装没装 Browser Use', () => {
  const app = (extensionId: string, native?: 'browser-use' | 'computer-use') => ({ extensionId, server: extensionId, digest: 'd',
    command: 'x', args: [], env: {}, cwd: '/tmp', dataDir: '/tmp', ...(native ? { native } : {}) })

  it('装着、开着、许给工具的 Browser Use 才算;别的 App、停用的、收回权限的不算', () => {
    const refusals: Record<string, string> = { off: 'Extension off is turned off' }
    const programs = (installed: ReturnType<typeof app>[]) => ({ installed: () => installed, agentToolsRefusal: (id: string) => refusals[id] ?? null })
    expect(browserUseAppInstalled(programs([]))).toBe(false)
    expect(browserUseAppInstalled(programs([app('computer', 'computer-use'), app('plain')]))).toBe(false)
    expect(browserUseAppInstalled(programs([app('off', 'browser-use')]))).toBe(false)
    expect(browserUseAppInstalled(programs([app('off', 'browser-use'), app('browser', 'browser-use')]))).toBe(true)
  })
})

describe('Browser Use availability after removing the host remote implementation', () => {
  async function bundleFor(personalAssistant?: true) {
    const host = createDesktopGuguMcpHost()
    hosts.push(host)
    return buildSessionBundle({
      runtime: {
        authProvider: { getAuth: async () => ({ accessToken: 'token', userId: randomUUID() }) },
        env: { GUGU_HOME: '/tmp/gugu-browser-availability' },
      },
      agentUserId: randomUUID(),
      threadRootId: null,
      autonomy: null,
      socialBridgeDeps: { host, grantKey: `taskpage:${randomUUID()}`, getSupabaseUrl: () => 'https://supabase.example', getSupabaseAnonKey: () => 'anon-key',
        ...(personalAssistant ? { personalAssistant, runSessionAction: async () => ({}) } : {}) },
    })
  }
  const ctx = { cwd: '/tmp/gugu-browser-availability', lifecycle: 'fresh' as const }
  it.each([true, false])('a server reports unavailable regardless of App installation (%s)', async installed => {
    for (const personalAssistant of [undefined, true] as const) {
      setBrowserUseApp({ server: true, installed: () => installed })
      const bundle = await bundleFor(personalAssistant)
      expect(bundle.browserUse).toBeUndefined()
      expect(bundle.browserRule).toBe('unavailable')
      const text = loadCodexAppServerCapabilities(bundle, ctx).developerInstructions ?? ''
      expect(text).toContain(BROWSER_UNAVAILABLE_RULE)
      expect(text).not.toContain('browser_request_login')
      expect(text).not.toContain('browser_request_takeover')
      expect(text).not.toContain('call `app_install`')
    }
  })

  it('does not probe an installed App to imply remote browser control', async () => {
    setBrowserUseApp({ server: true, installed: () => { throw new Error('must not inspect the shell App') } })
    expect((await bundleFor()).browserRule).toBe('unavailable')
  })

  it.each([true, false])('keeps local App discovery and the Codex browser flag (%s)', async installed => {
    setBrowserUseApp({ server: false, installed: () => installed })
    const bundle = await bundleFor()
    expect(bundle.browserUse).toBe(installed ? true : undefined)
    expect(bundle.browserRule).toBeUndefined()
    expect(loadCodexAppServerCapabilities(bundle, ctx).developerInstructions).not.toContain(BROWSER_UNAVAILABLE_RULE)
  })
})

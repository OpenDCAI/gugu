import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAcpModelCapability } from '../../../../apps/desktop/electron/capability-bundle'
import {
  buildProbePlatformCredentials, PROBE_MODEL_ID, PROBE_RELAY_ROOT, PROBE_RELAY_TOKEN,
} from '../../../../apps/desktop/electron/harness-catalog-probe-env'
import {
  materializePiSessionBundle, PI_GUGU_CAPABILITY_PACKAGE,
} from '../../../../packages/session-plugins/src/agents/impl/pi/session-bundle'

let scratch: string
beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), 'pi-catalog-config-')) })
afterEach(async () => { await rm(scratch, { recursive: true, force: true }) })

describe('Pi catalog probe configuration', () => {
  it('writes the production models/settings artifacts under its scratch root', async () => {
    const credentials = await buildProbePlatformCredentials('pi', scratch)
    const model = buildAcpModelCapability({
      dialect: 'pi-models-json', engineId: 'pi', model: PROBE_MODEL_ID, env: {},
      platformAccess: { relayUrl: PROBE_RELAY_ROOT, token: PROBE_RELAY_TOKEN, contextWindow: null },
    })
    const session = materializePiSessionBundle({ surface: 'acp', lifecycle: 'fresh', cwd: scratch }, {
      env: { GUGU_HOME: scratch }, model, mcpServers: [], autonomy: null, promptBlocks: {},
      packages: [PI_GUGU_CAPABILITY_PACKAGE],
    })
    const files = session.artifacts.filter((artifact) => ['models.json', 'settings.json'].includes(basename(artifact.path)))
    expect(files).toHaveLength(2)
    for (const artifact of files) {
      expect(relative(scratch, artifact.path)).not.toMatch(/^\.\./)
      expect(await readFile(artifact.path, 'utf8')).toBe(artifact.content)
      if (process.platform !== 'win32') expect((await stat(artifact.path)).mode & 0o777).toBe(0o600)
    }
    const agentDir = credentials.env.PI_CODING_AGENT_DIR!
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    const modelsText = await readFile(join(agentDir, 'models.json'), 'utf8')
    const provider = JSON.parse(modelsText).providers[settings.defaultProvider]
    expect(settings.defaultModel).toBe(PROBE_MODEL_ID)
    expect(provider.models.map((entry: { id: string }) => entry.id)).toContain(settings.defaultModel)
    expect(provider.baseUrl).toBe(`${PROBE_RELAY_ROOT}/v1`)
    expect(provider.apiKey).toBe('${GUGU_PI_API_KEY}')
    expect(modelsText).not.toContain(PROBE_RELAY_TOKEN)
    expect(credentials.env.GUGU_PI_API_KEY).toBe(PROBE_RELAY_TOKEN)
    expect(credentials.env.PI_CODING_AGENT_DIR).toBe(session.env.PI_CODING_AGENT_DIR)
  })

  it('reports a configuration write failure instead of returning empty credentials', async () => {
    const file = join(scratch, 'not-a-directory')
    await writeFile(file, 'occupied')
    await expect(buildProbePlatformCredentials('pi', file)).rejects.toThrow()
  })
})

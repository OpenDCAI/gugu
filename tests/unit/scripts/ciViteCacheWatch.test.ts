import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createServer, loadConfigFromFile } from 'vite'
import { awaitFact } from '../../support/awaitFact'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

it.each(['vitest.config.ts', 'vite.config.mts'])('%s watches source without allocating watches for the workspace dependency cache', async configFile => {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, resolve(configFile))
  expect(loaded).not.toBeNull()
  const root = mkdtempSync(join(tmpdir(), 'ci-vite-watch-')); roots.push(root)
  const source = join(root, 'src'), cache = join(root, '.ci-cache', 'pnpm', 'v10', 'files')
  mkdirSync(source, { recursive: true }); mkdirSync(cache, { recursive: true })
  writeFileSync(join(source, 'app.ts'), 'export const value = 1\n')
  writeFileSync(join(cache, 'cached-package'), 'dependency bytes\n')
  const server = await createServer({
    configFile: false, root, appType: 'custom',
    server: { watch: loaded!.config.server?.watch, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  try {
    await awaitFact('the real Vite watcher has enumerated the ordinary source file', () =>
      server.watcher.getWatched()[source]?.includes('app.ts') ? true : undefined)
    const watched = Object.entries(server.watcher.getWatched()).flatMap(([directory, files]) =>
      [directory, ...files.map(file => join(directory, file))])
    expect(watched.filter(file => file === cache || file.startsWith(cache + sep))).toEqual([])
    expect(watched).toContain(join(source, 'app.ts'))
  } finally {
    await server.close()
  }
})

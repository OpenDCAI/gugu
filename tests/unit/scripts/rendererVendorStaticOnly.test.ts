// @@@vendor-static-only — vendor 只收咕咕入口**静态**够得到的包。vendor 在 index.html 里被
// modulepreload,rollup 的 ESM 产物在 chunk 加载时就执行它的每一个模块;只经 import() 够得到的包
// 进了 vendor,就等于把写好的懒加载在启动时全部提前执行(mac1 2026-09-25:16.6 MB / 25.2 MB)。
import { describe, expect, it } from 'vitest'
import {
  computeEntryReachability,
  entryAwareRendererManualChunk,
  type EntryReachability,
  type ModuleGraphContext,
} from '../../../scripts/build/renderer-chunking.mts'

const NM = '/repo/node_modules'
const graph: Record<string, { isEntry?: boolean; importedIds?: string[]; dynamicallyImportedIds?: string[] }> = {
  '/repo/apps/desktop/index.html': { isEntry: true, importedIds: ['/repo/apps/desktop/src/main.tsx'] },
  '/repo/apps/desktop/src/main.tsx': {
    importedIds: [`${NM}/react/index.js`, `${NM}/zod/index.js`],
    dynamicallyImportedIds: ['/repo/apps/desktop/src/task/renderer/lib/ui/mermaid-renderer.ts'],
  },
  '/repo/apps/desktop/src/task/renderer/lib/ui/mermaid-renderer.ts': { importedIds: [`${NM}/mermaid/dist/mermaid.js`] },
  [`${NM}/mermaid/dist/mermaid.js`]: { importedIds: [`${NM}/zod/index.js`] },
  [`${NM}/react/index.js`]: {},
  [`${NM}/zod/index.js`]: {},
  '/repo/apps/desktop/task-embedded.html': { isEntry: true, importedIds: [`${NM}/monaco-editor/esm/editor.js`] },
  [`${NM}/monaco-editor/esm/editor.js`]: {},
}
const ctx: ModuleGraphContext = {
  getModuleIds: () => Object.keys(graph),
  getModuleInfo: (id) => graph[id] ?? null,
}
const isGuguEntry = (id: string) => id.endsWith('apps/desktop/index.html')

describe('renderer vendor chunk', () => {
  const reachability: EntryReachability = { guguReachable: computeEntryReachability(ctx, isGuguEntry) }
  const chunkOf = entryAwareRendererManualChunk(reachability)

  it('groups packages the gugu entry imports statically', () => {
    expect(chunkOf(`${NM}/react/index.js`)).toBe('vendor-react')
    expect(chunkOf(`${NM}/zod/index.js`)).toBe('vendor')
  })

  it('leaves packages reachable only through import() to their own lazy chunk', () => {
    // Positive control above: the same graph does produce 'vendor'; this one is only behind import().
    expect(chunkOf(`${NM}/mermaid/dist/mermaid.js`)).toBeUndefined()
    expect(reachability.guguReachable?.has('/repo/apps/desktop/src/task/renderer/lib/ui/mermaid-renderer.ts')).toBe(false)
  })

  it('keeps packages only the task entry reaches out of the gugu vendor', () => {
    expect(chunkOf(`${NM}/monaco-editor/esm/editor.js`)).toBeUndefined()
  })
})

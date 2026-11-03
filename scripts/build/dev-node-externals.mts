import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Plugin } from 'vite'

export interface DependencyManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** Node loads installed CommonJS packages in development; ESM and local source stay bundled. */
export function devNodeExternals(manifest: DependencyManifest): Plugin {
  const installed = new Set(
    Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })
      .filter(([, version]) => !/^(workspace|file|link|portal):/.test(version))
      .map(([name]) => name),
  )
  const nativeEntries = new Set<string>()
  const commonJsEntries = new Map<string, boolean>()
  const isCommonJs = (entry: string): boolean => {
    const cached = commonJsEntries.get(entry)
    if (cached !== undefined) return cached
    let commonJs = !entry.endsWith('.mjs')
    if (entry.endsWith('.js')) {
      let directory = dirname(entry)
      while (basename(directory) !== 'node_modules' && dirname(directory) !== directory) {
        const manifest = join(directory, 'package.json')
        if (existsSync(manifest)) {
          commonJs = JSON.parse(readFileSync(manifest, 'utf8')).type !== 'module'
          break
        }
        directory = dirname(directory)
      }
    }
    commonJsEntries.set(entry, commonJs)
    return commonJs
  }
  const resolveInstalled = (source: string, importer?: string): string | null => {
    const name = source.split('/').slice(0, source.startsWith('@') ? 2 : 1).join('/')
    if (!installed.has(name) || !importer) return null
    const parent = importer.replace(/^\0/, '').split('?')[0]
    if (!isAbsolute(parent)) return null
    try {
      // The CJS output needs Node's require entry, not Vite's preferred `module` entry.
      // Resolving from the importer also preserves nested package versions.
      const entry = createRequire(parent).resolve(source)
      if (!isAbsolute(entry) || !entry.replaceAll('\\', '/').includes('/node_modules/')
        || !/\.(?:[cm]?js|json|node)$/.test(entry) || !isCommonJs(entry)) return null
      // Keep ESM in the graph so its imports use the same CJS instances as local code.
      // Native ESM imports bypass this graph and can create a second Yjs constructor family.
      nativeEntries.add(entry)
      return entry
    } catch {
      // Import-only exports and other bundler-only packages keep their existing build path.
      return null
    }
  }
  return {
    name: 'gugu-dev-node-externals',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!this.meta.watchMode) return null
      const id = resolveInstalled(source, importer)
      return id ? { id, external: true } : null
    },
    options(options) {
      // The Electron plugin uses Rollup watch even though the outer Vite command is `serve`.
      if (!this.meta.watchMode) return null
      nativeEntries.clear()
      const original = options.external
      return {
        ...options,
        external(source: string, importer: string | undefined, resolved: boolean) {
          // CommonJS may resolve packages before our resolveId hook. Only externalize a
          // resolved ID if it is a Node entry selected for an original importer.
          if (!resolved) resolveInstalled(source, importer)
          if (resolved && nativeEntries.has(source)) return true
          if (typeof original === 'function') return original(source, importer, resolved)
          const entries = Array.isArray(original) ? original : original ? [original] : []
          return entries.some(entry => typeof entry === 'string' ? entry === source : entry.test(source))
        },
      }
    },
  }
}

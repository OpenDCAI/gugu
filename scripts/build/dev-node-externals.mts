import { isAbsolute } from 'node:path'
import type { Plugin } from 'vite'

export interface DependencyManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** Node loads installed packages itself in development; Rollup only watches application source. */
export function devNodeExternals(manifest: DependencyManifest): Plugin {
  const installed = new Set(
    Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })
      .filter(([, version]) => !/^(workspace|file|link|portal):/.test(version))
      .map(([name]) => name),
  )
  return {
    name: 'gugu-dev-node-externals',
    apply: 'build',
    enforce: 'pre',
    options(options) {
      // The Electron plugin uses Rollup watch even though the outer Vite command is `serve`.
      // Production builds keep their existing bundling and packaging contract.
      if (!this.meta.watchMode) return null
      const original = options.external
      return {
        ...options,
        // Externalize the resolved instance, not its bare name: bundled workspace code may
        // resolve a different package version from the application's root node_modules.
        external(source: string, importer: string | undefined, resolved: boolean) {
          if (resolved && isAbsolute(source) && !source.includes('\0')) {
            const normalized = source.replaceAll('\\', '/')
            const packagePath = normalized.split('/node_modules/').at(-1)!
            if (packagePath !== normalized) {
              const name = packagePath.split('/').slice(0, packagePath.startsWith('@') ? 2 : 1).join('/')
              if (installed.has(name)) return true
            }
          }
          if (typeof original === 'function') return original(source, importer, resolved)
          const entries = Array.isArray(original) ? original : original ? [original] : []
          return entries.some(entry => typeof entry === 'string' ? entry === source : entry.test(source))
        },
      }
    },
  }
}

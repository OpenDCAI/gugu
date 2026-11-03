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
        // Rollup checks this before resolvers, including the CommonJS plugin's package resolution.
        external(source: string, importer: string | undefined, resolved: boolean) {
          const name = source.split('/').slice(0, source.startsWith('@') ? 2 : 1).join('/')
          if (installed.has(name)) return true
          if (typeof original === 'function') return original(source, importer, resolved)
          const entries = Array.isArray(original) ? original : original ? [original] : []
          return entries.some(entry => typeof entry === 'string' ? entry === source : entry.test(source))
        },
      }
    },
  }
}

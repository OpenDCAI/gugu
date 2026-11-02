import type { Plugin } from 'vite'
import { packageIdentity, SERVER_PACKAGE_IDENTITY } from '../../apps/desktop/electron/server/server-package-environment.mts'

/** Emitted by the same build and inputs that bake the server's backend, never reconstructed at packaging time. */
export function serverPackageIdentity(backendUrl: string, channel: string): Plugin {
  return {
    name: 'gugu-server-package-identity',
    generateBundle(_options, bundle) {
      if (!backendUrl || !Object.values(bundle).some(entry => entry.type === 'chunk' && entry.isEntry && entry.name === 'server')) return
      this.emitFile({ type: 'asset', fileName: SERVER_PACKAGE_IDENTITY,
        source: `${JSON.stringify(packageIdentity({ schema: 1, backendUrl, channel }))}\n` })
    },
  }
}

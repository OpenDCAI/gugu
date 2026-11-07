import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildIntegrationListPayload } from '../../apps/desktop/electron/session/main/core/integrations/integration-payload-builder'

// Generate only the public list payload. Provider SDKs, credential stores and
// host behavior must never be imported by the renderer's bundled catalog.
const publicCatalog = (locale: string) => buildIntegrationListPayload(locale).map(({ icon: _icon, ...item }) => item)
const locales = { en: publicCatalog('en-US'), 'zh-CN': publicCatalog('zh-CN') }
const sha256 = createHash('sha256').update(JSON.stringify(locales)).digest('hex')
const bytes = JSON.stringify({ version: 1, sha256, locales }) + '\n'
const path = resolve('apps/desktop/src/components/connections/builtin-catalog.generated.json')
async function main() {
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error('Connection catalog differs from the provider registry; run gen-connection-catalog.ts')
  } else {
    await writeFile(path, bytes)
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })

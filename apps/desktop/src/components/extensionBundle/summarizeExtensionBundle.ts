import { EXTENSION_ARCHIVE_MIME, resolveAttachmentMimeType } from '@gugu/core/shared/imageMime.mjs'
import type { AttachmentMeta } from '@gugu/core/shared/ui/attachmentModels'
import { ENGINES_RANGE_PATTERN, safeParseExtensionManifest, type ExtensionManifest } from '@shared/extensions/manifest'
import { compatOf, currentMarketHost, marketCompatText, type MarketCompat, type MarketIndex } from '@shared/extensions/market'

/**
 * What a chat card shows about an extension package (#6646), read from the file itself — never from
 * what the sender wrote about it. Only `manifest.json` is read; nothing else in the package is drawn.
 */

export type ExtensionBundleSummary =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; problem: string; compat?: NonNullable<MarketCompat> }

export function isExtensionBundle(meta: Pick<AttachmentMeta, 'fileName' | 'mimeType'>): boolean {
  return resolveAttachmentMimeType(meta.fileName, meta.mimeType) === EXTENSION_ARCHIVE_MIME
}

/**
 * Read compatibility from the raw manifest: API first, then engines, exactly as the market does. A package made for
 * another host is an update instruction rather than an unreadable file, even when this schema cannot parse it.
 */
function newerAppNeeded(raw: unknown, appVersion: string, hostApi?: MarketIndex['hostApi']): MarketCompat {
  const manifest = raw as { apiVersion?: unknown; engines?: { gugu?: unknown } } | null
  if (typeof manifest?.apiVersion !== 'number' || !Number.isInteger(manifest.apiVersion)) return null
  const range = manifest.engines?.gugu
  const min = typeof range === 'string' ? ENGINES_RANGE_PATTERN.exec(range)?.[2] : undefined
  return compatOf({ apiVersion: manifest.apiVersion, minAppVersion: min ?? '0.0.0' }, currentMarketHost(appVersion, 'desktop'), hostApi)
}

export async function summarizeExtensionBundle(bytes: Uint8Array, appVersion: string, hostApi?: MarketIndex['hostApi']): Promise<ExtensionBundleSummary> {
  const { default: JSZip } = await import('jszip')
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return { ok: false, problem: 'not a zip archive' }
  }
  const entry = zip.file('manifest.json')
  if (!entry) return { ok: false, problem: 'no manifest.json at the top of the package' }
  let raw: unknown
  try {
    raw = JSON.parse(await entry.async('string'))
  } catch (error) {
    return { ok: false, problem: error instanceof SyntaxError ? 'manifest.json is not valid JSON' : String((error as Error).message) }
  }
  const parsed = safeParseExtensionManifest(raw)
  const compat = newerAppNeeded(raw, appVersion, hostApi)
  if (parsed.ok && !compat) return { ok: true, manifest: parsed.manifest }
  return { ok: false, problem: parsed.ok ? marketCompatText(compat!) : parsed.issues.join('; '), ...(compat ? { compat } : {}) }
}

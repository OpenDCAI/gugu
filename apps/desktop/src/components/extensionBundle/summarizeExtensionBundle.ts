import { EXTENSION_ARCHIVE_MIME, resolveAttachmentMimeType } from '@gugu/core/shared/imageMime.mjs'
import type { AttachmentMeta } from '@gugu/core/shared/ui/attachmentModels'
import { ENGINES_RANGE_PATTERN, safeParseExtensionManifest, type ExtensionManifest } from '@shared/extensions/manifest'
import { appSatisfies } from '@shared/extensions/market'

/**
 * What a chat card shows about an extension package (#6646), read from the file itself — never from
 * what the sender wrote about it. Only `manifest.json` is read; nothing else in the package is drawn.
 */

export type ExtensionBundleSummary =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; problem: string; needsApp?: string }

export function isExtensionBundle(meta: Pick<AttachmentMeta, 'fileName' | 'mimeType'>): boolean {
  return resolveAttachmentMimeType(meta.fileName, meta.mimeType) === EXTENSION_ARCHIVE_MIME
}

/**
 * A package this gugu cannot read, made for a newer one: its own \`engines.gugu\` says so (the field every market App
 * carries), and the card then says 「update gugu」 — the market's words (\`needs-newer-app\`) — not 「unreadable」. Read
 * from the raw manifest because a newer manifest is exactly what the parse refuses (a field this build does not know).
 */
function newerAppNeeded(raw: unknown, appVersion: string): string | null {
  const range = (raw as { engines?: { gugu?: unknown } } | null)?.engines?.gugu
  const min = typeof range === 'string' ? ENGINES_RANGE_PATTERN.exec(range)?.[2] : undefined
  return min && !appSatisfies(min, appVersion) ? min : null
}

export async function summarizeExtensionBundle(bytes: Uint8Array, appVersion: string): Promise<ExtensionBundleSummary> {
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
  if (parsed.ok) return { ok: true, manifest: parsed.manifest }
  const needsApp = newerAppNeeded(raw, appVersion)
  return { ok: false, problem: parsed.issues.join('; '), ...(needsApp ? { needsApp } : {}) }
}

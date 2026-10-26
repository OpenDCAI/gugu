import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'

const ATTACHMENTS = /(?:^|\n)附件（原件引用与校验信息；仅元数据）：/g
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A view of the producer's trailing protocol blocks; never modifies the durable exchange or Agent input. */
export function taskExchangeContent(content: string): { text: string; files: ParsedAttachment[]; invalidAttachments: boolean } {
  let text = content.trimEnd()
  const protocol = /(?:^|\n)<(gugu_work(?:_result)?)>\s*\n?[\s\S]*?\n?<\/\1>\s*$/
  for (let block = protocol.exec(text); block; block = protocol.exec(text)) text = text.slice(0, block.index).trimEnd()
  const marker = [...text.matchAll(ATTACHMENTS)].at(-1)
  if (!marker) return { text, files: [], invalidAttachments: false }
  const raw = text.slice(marker.index + marker[0].length).trim()
  // Only the actual appended metadata block is protocol; quoted examples and inline mentions are ordinary prose.
  if ((!raw.startsWith('[') && !raw.startsWith('{')) || raw.endsWith('```')) return { text, files: [], invalidAttachments: false }
  text = text.slice(0, marker.index).trimEnd()
  try {
    const refs: unknown = JSON.parse(raw)
    if (!Array.isArray(refs) || refs.length === 0 || refs.length > 8) throw new Error('Invalid attachment references')
    const files = refs.map((ref: unknown): ParsedAttachment => {
      if (!ref || typeof ref !== 'object') throw new Error('Invalid attachment reference')
      const file = ref as Record<string, unknown>
      if (typeof file.attachment_id !== 'string' || !uuid.test(file.attachment_id)
        || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.size_bytes) || (file.size_bytes as number) < 0
        || typeof file.file_name !== 'string' || !file.file_name.trim()
        || typeof file.content_type !== 'string' || !file.content_type.trim()) throw new Error('Invalid attachment reference')
      return { kind: 'file', fileName: file.file_name, mimeType: file.content_type, sizeBytes: file.size_bytes as number,
        source: { kind: 'attachment', attachmentId: file.attachment_id } }
    })
    return { text, files, invalidAttachments: false }
  } catch { return { text, files: [], invalidAttachments: true } }
}

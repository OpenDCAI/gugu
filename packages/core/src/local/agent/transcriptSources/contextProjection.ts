import type { TranscriptContext } from '../../../shared/types/transcripts'
import { asRecord } from '../transcriptSource'

export type ContextFrame = Partial<Pick<TranscriptContext, 'loaded' | 'nested' | 'refs'>>

/** Only the input of the source's file/shell tools. No outputs, reasoning or free-text conversation is inspected. */
export function contextToolRefs(name: string, input: unknown): string[] {
  const tool = name.split('.').at(-1)
  if (!tool || !['Read', 'Edit', 'Write', 'Bash', 'exec_command'].includes(tool)) return []
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { /* Native custom tools may pass plain shell text. */ }
  }
  const strings: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  visit(input)
  const direct = asRecord(input)
  const paths = typeof direct?.file_path === 'string' ? [direct.file_path] : []
  // Absolute/home/relative paths, plus plain filenames. Quoted structured file_path stays intact above.
  const pattern = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)[^\s"'`<>|;&]+|[\w.-]+\.(?:md|toml|json|ya?ml)\b/g
  for (const text of strings) for (const match of text.matchAll(pattern)) paths.push(match[0].replace(/[),]+$/, ''))
  return [...new Set(paths)]
}

export function contextText(value: unknown): string | null {
  if (typeof value === 'string') return value
  const text = asRecord(value)?.text
  return typeof text === 'string' ? text : null
}

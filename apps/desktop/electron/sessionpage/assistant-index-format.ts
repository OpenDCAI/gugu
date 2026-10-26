/** One bounded data snapshot, never split or truncated in the middle of a record. */
export const ASSISTANT_INDEX_LIMIT = 6_000
const json = (value: unknown) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
  character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
const order = (value: unknown): string => json(value)
const compare = (a: unknown, b: unknown) => order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0
type Row = Record<string, unknown>

export function boundedAssistantIndex(lines: string[], details?: string): string {
  const rows = lines.map(line => line.startsWith('{') ? JSON.parse(line) as Row : line)
  for (const row of rows) {
    if (typeof row === 'string') continue
    if (Array.isArray(row.items)) row.items.sort(compare)
    if (Array.isArray(row.groups)) row.groups.sort(compare)
  }
  const omissions: Record<string, number> = {}
  let trimmed = false
  const footer = () => (trimmed && details ? `其余见 ${details}\n` : '') + (Object.keys(omissions).length ? json({ source: 'index_budget', omitted_records: omissions,
    read: ['session_devices', 'project_list', 'library_read'], complete: false }) + '\n' : ''
  )
  const render = () => rows.map(row => typeof row === 'string' ? row : json(row)).join('\n')
    .replace('</gugu_resource_index>', footer() + '</gugu_resource_index>')
  let result = render()
  while (result.length > ASSISTANT_INDEX_LIMIT) {
    trimmed = true
    // Trim collections before dropping any device: routing takes precedence over catalog detail.
    const collection = rows.filter((row): row is Row => typeof row !== 'string' && row.source !== 'integrations' && Array.isArray(row.items) && row.items.length > 0)
      .sort((a, b) => json(b.items).length - json(a.items).length)[0]
    if (collection) {
      (collection.items as unknown[]).pop()
      collection.omitted_items = Number(collection.omitted_items ?? 0) + 1
    } else {
      const candidates = rows.filter((row): row is Row => typeof row !== 'string' && !row.account && row.source !== 'integrations' && row.source !== 'resource_version')
      const candidate = candidates.find(row => !row.device_id) ?? candidates.at(-1)
      if (!candidate) throw new Error('Assistant required resources exceed their context budget')
      const source = String(candidate.source ?? 'devices')
      omissions[source] = (omissions[source] ?? 0) + 1
      rows.splice(rows.indexOf(candidate), 1)
    }
    result = render()
  }
  return result
}

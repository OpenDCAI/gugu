/** Immutable initial input to an App view in a message. Unknown v2 keys are ignored. */
export interface WidgetMessage {
  v: 2
  text: string
  app: string
  view: string
  data?: Record<string, unknown>
}

export const WIDGET_DATA_MAX_BYTES = 4096
export const WIDGET_CONTENT_MAX_BYTES = 6144
const bytes = (text: string) => new TextEncoder().encode(text).length
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The last top-level data object's source bytes, matching the database's json -> data (including whitespace/escapes). */
function dataSourceBytes(content: string): number {
  let depth = 0, start = -1, size = 0
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    if (char === '"') {
      const first = i++
      while (i < content.length && content[i] !== '"') { if (content[i] === '\\') i++; i++ }
      if (depth === 1 && JSON.parse(content.slice(first, i + 1)) === 'data') {
        const colon = /^\s*:\s*/.exec(content.slice(i + 1))
        if (colon) start = i + 1 + colon[0].length
      }
    } else if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') {
      depth--
      if (depth === 1 && start >= 0) { size = bytes(content.slice(start, i + 1)); start = -1 }
    }
  }
  return size
}

/** The same checks at the tool and the untrusted rendering boundary; errors include measured byte sizes. */
export function widgetMessageError(value: unknown): string | null {
  if (!object(value) || value.v !== 2) return 'widget must be a v2 object'
  if ('id' in value || 'title' in value) return 'widget cannot contain top-level id or title'
  if (typeof value.text !== 'string' || !value.text.length || [...value.text].length > 200) return 'text must contain 1–200 plain text characters'
  if (typeof value.app !== 'string' || !value.app.length || typeof value.view !== 'string' || !value.view.length) return 'app and view are required'
  if (value.data !== undefined) {
    if (!object(value.data)) return 'data must be a JSON object'
    const size = bytes(JSON.stringify(value.data))
    if (size > WIDGET_DATA_MAX_BYTES) return `data is ${size} UTF-8 bytes; maximum is ${WIDGET_DATA_MAX_BYTES}`
  }
  return null
}

/** Malformed, legacy and oversized messages keep the old [Widget] placeholder. */
export function parseWidgetMessage(content: string | null | undefined): WidgetMessage | null {
  if (!content || bytes(content) > WIDGET_CONTENT_MAX_BYTES) return null
  try {
    const raw: unknown = JSON.parse(content)
    if (widgetMessageError(raw)) return null
    if (dataSourceBytes(content) > WIDGET_DATA_MAX_BYTES) return null
    const { text, app, view, data } = raw as WidgetMessage
    return { v: 2, text, app, view, ...(data === undefined ? {} : { data }) }
  } catch { return null }
}

export function serializeWidgetMessage(widget: WidgetMessage): string {
  const error = widgetMessageError(widget)
  if (error) throw new Error(error)
  const content = JSON.stringify(widget)
  const size = bytes(content)
  if (size > WIDGET_CONTENT_MAX_BYTES) throw new Error(`content is ${size} UTF-8 bytes; maximum is ${WIDGET_CONTENT_MAX_BYTES}`)
  return content
}

// Reply previews are cut to 280 characters by older backends, as composer-card previews are.
const PREVIEW_HEAD = /^\{"v":2,"text":"((?:[^"\\]|\\u[0-9a-fA-F]{4}|\\[^u])*)/
export function widgetMessagePreview(preview: string | null | undefined): string | null {
  const head = preview ? PREVIEW_HEAD.exec(preview) : null
  if (!head) return null
  try { return JSON.parse(`"${head[1]}"`) as string } catch { return null }
}

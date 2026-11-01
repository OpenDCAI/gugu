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

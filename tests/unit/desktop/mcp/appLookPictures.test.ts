import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { registerSessionpageTools, withPictures } from '../../../../apps/desktop/electron/mcp/sessionpage-tool-registrar'
import { registerGuguGuideTools, setGuideLookPicture } from '../../../../apps/desktop/electron/mcp/gugu-guide-tool'
import { EXTENSION_GUIDE_UI } from '../../../../apps/desktop/src/session/shared/extensions/authoring-guide'

/**
 * Pictures reach the agent as images: app_check's (its page 440 / 412 wide, light / dark) and the one picture of
 * gugu's look in guide apps-ui. Never as base64 text in the JSON — four of them are ~160 KB in the agent's context.
 */

type Content = { type: string; text?: string; data?: string; mimeType?: string }
type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{ content: Content[]; isError?: boolean }>

/** The handlers a server would register, by name. */
function fakeServer(): { server: never; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const server = { registerTool: (name: string, _definition: unknown, handler: Handler) => void handlers.set(name, handler) }
  return { server: server as never, handlers }
}

const PICTURE = { label: '440 wide (a chat\'s side panel), light', mimeType: 'image/jpeg' as const, data: 'AAAA' }
const extra = { signal: new AbortController().signal }

describe('app_check\'s pictures are images after the JSON', () => {
  it('takes them out of the result and says each by its label', () => {
    const { shown, pictures } = withPictures({ ok: true, text: 'hi', pictures: [PICTURE] })
    expect(shown).toEqual({ ok: true, text: 'hi' })
    expect(pictures).toEqual([
      { type: 'text', text: `Picture: ${PICTURE.label}` },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
    ])
    // A result without pictures is left as it is.
    expect(withPictures({ ok: true })).toEqual({ shown: { ok: true }, pictures: [] })
    // Not pictures (no data): said, not passed on as text.
    expect(() => withPictures({ pictures: [{ label: 'x' }] })).toThrow(/not \{ label, mimeType, data \}/)
  })

  it('through a registered tool: one JSON text without the base64, then the pictures', async () => {
    const { server, handlers } = fakeServer()
    registerSessionpageTools(server, [{ name: 'app_check', description: 'check', schema: z.object({}).strict(), action: 'check' }],
      async () => ({ ok: true, next: 'look', pictures: [PICTURE, { ...PICTURE, label: '412 wide (a phone, touch), dark' }] }),
      () => 'unavailable', (work) => work)
    const { content } = await handlers.get('app_check')!({}, extra)
    expect(content.map(({ type }) => type)).toEqual(['text', 'text', 'image', 'text', 'image'])
    expect(content[0]!.text).not.toContain('AAAA')
    expect(JSON.parse(content[0]!.text!)).toEqual({ ok: true, next: 'look' })
  })
})

describe('guide_read apps-ui shows gugu\'s look as a picture', () => {
  afterEach(() => setGuideLookPicture(null))

  it('the guide, then its picture, drawn by the host', async () => {
    setGuideLookPicture(async () => ({ ...PICTURE, label: 'gugu\'s look' }))
    const { server, handlers } = fakeServer()
    registerGuguGuideTools(server)
    const { content } = await handlers.get('guide_read')!({ topic: 'apps-ui' }, extra)
    expect(content).toEqual([
      { type: 'text', text: EXTENSION_GUIDE_UI },
      { type: 'text', text: 'Picture: gugu\'s look' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
    ])
    // Another guide has no picture.
    const page = await handlers.get('guide_read')!({ topic: 'apps-page' }, extra)
    expect(page.content.map(({ type }) => type)).toEqual(['text'])
  })

  it('where no picture can be drawn (a Gugu server): the text alone; a picture that fails is said, not swallowed', async () => {
    const { server, handlers } = fakeServer()
    registerGuguGuideTools(server)
    expect((await handlers.get('guide_read')!({ topic: 'apps-ui' }, extra)).content).toEqual([{ type: 'text', text: EXTENSION_GUIDE_UI }])
    setGuideLookPicture(async () => {
      throw new Error('the App runtime is missing from this build')
    })
    const { content } = await handlers.get('guide_read')!({ topic: 'apps-ui' }, extra)
    expect(content).toHaveLength(1)
    expect(content[0]!.text).toContain('could not be drawn here: the App runtime is missing from this build')
  })
})

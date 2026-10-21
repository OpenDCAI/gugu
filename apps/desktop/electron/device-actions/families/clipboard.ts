/**
 * 剪贴板(clipboard.read / clipboard.write;Mac、Windows、Linux 都有这一组)。
 * 读到图片时把图交给 agent 看(pictures),❌ 把 base64 塞进文字结果。
 */
import { bad, ok, str, type ActionFamily } from '../catalog'

export function createClipboardFamily(): ActionFamily {
  return {
    groups: [{ id: 'clipboard', platforms: ['darwin', 'win32', 'linux'] }],
    actions: [
      {
        name: 'clipboard.read',
        group: 'clipboard',
        title: '读剪贴板',
        titleEn: 'Read clipboard',
        description: 'Read the current clipboard of this computer: its text (up to 64 KB) and, if an image was copied, the image itself (returned as a picture you can see).',
        risk: 'medium',
        confirm: 'never',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        async run(_args, ctx) {
          const text = String(await ctx.deps.clipboardRead())
          const image = await ctx.deps.clipboardReadImage?.() ?? null
          return ok({
            text: text.slice(0, 65_536),
            truncated: text.length > 65_536,
            has_image: image !== null,
            ...(image ? { image_size: { width: image.width, height: image.height }, pictures: [{ label: 'clipboard image', mimeType: image.mimeType, data: image.data }] } : {}),
          })
        },
      },
      {
        name: 'clipboard.write',
        group: 'clipboard',
        title: '写剪贴板',
        titleEn: 'Write clipboard',
        description: 'Put text on this computer\'s clipboard (replaces what was there).',
        risk: 'low',
        confirm: 'never',
        input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'Text to write to the clipboard' } }, additionalProperties: false },
        validate: (args) => (typeof args.text === 'string' ? null : 'text must be a string'),
        async run(args, ctx) {
          const text = typeof args.text === 'string' ? args.text : str(args, 'text')
          if (text.length > 4 * 1024 * 1024) return bad('text is larger than 4 MB')
          await ctx.deps.clipboardWrite(text)
          return ok({ written: text.length })
        },
      },
    ],
  }
}

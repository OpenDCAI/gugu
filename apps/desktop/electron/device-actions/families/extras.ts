/**
 * 咕咕另带的三组(#7199 第一批就要的):发系统通知、在默认浏览器里打开链接、运行「快捷指令」。
 * 快捷指令能做的事很多,每次运行都要先问用户(confirm = always)。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEVICE_ACTION_CONFIRMED_ARG } from '@gugu/core/shared/deviceActions'
import { fail, ok, str, type ActionFamily } from '../catalog'

const SHORTCUTS = '/usr/bin/shortcuts'

export function createExtrasFamily(): ActionFamily {
  return {
    groups: [
      {
        id: 'notification',
        platforms: ['darwin', 'win32', 'linux'],
        settingsUrl: 'x-apple.systempreferences:com.apple.preference.notifications',
        async probe(ctx) {
          ctx.deps.notify('咕咕', '这台电脑可以收到助理发来的通知了')
          return ok(null)
        },
      },
      { id: 'url', platforms: ['darwin', 'win32', 'linux'] },
      {
        id: 'shortcuts',
        platforms: ['darwin'],
        iconApp: '/System/Applications/Shortcuts.app',
        async probe(ctx) {
          const r = await ctx.deps.exec(SHORTCUTS, ['list'], { signal: ctx.signal, timeoutMs: 60_000 })
          return r.code === 0 ? ok(null) : fail('execution_failed', `读不到快捷指令：${(r.stderr || r.stdout).trim().slice(0, 300)}`)
        },
      },
    ],
    actions: [
      {
        name: 'notification.show',
        group: 'notification',
        title: '发通知',
        titleEn: 'Show notification',
        description: 'Show a system notification on this computer (the banner in the corner of the screen). title is required, body optional.',
        risk: 'low',
        confirm: 'never',
        input_schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, body: { type: 'string' } }, additionalProperties: false },
        validate: (args) => (str(args, 'title') ? null : 'title is required'),
        async run(args, ctx) {
          ctx.deps.notify(str(args, 'title').slice(0, 200), str(args, 'body').slice(0, 1000))
          return ok({ shown: true })
        },
      },
      {
        name: 'url.open',
        group: 'url',
        title: '打开链接',
        titleEn: 'Open link',
        description: 'Open an http(s) link in this computer\'s default browser (the person will see it open on screen).',
        risk: 'medium',
        confirm: 'never',
        input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } }, additionalProperties: false },
        validate: (args) => (/^https?:\/\//i.test(str(args, 'url')) ? null : 'url must start with http:// or https://'),
        async run(args, ctx) {
          await ctx.deps.openExternal(str(args, 'url'))
          return ok({ opened: str(args, 'url') })
        },
      },
      {
        name: 'shortcuts.list',
        group: 'shortcuts',
        title: '列出快捷指令',
        titleEn: 'List shortcuts',
        description: 'List the names of all shortcuts in this Mac\'s Shortcuts app.',
        risk: 'low',
        confirm: 'never',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        async run(_args, ctx) {
          const r = await ctx.deps.exec(SHORTCUTS, ['list'], { signal: ctx.signal, timeoutMs: 60_000 })
          if (r.code !== 0) return fail('execution_failed', `shortcuts list failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
          return ok({ shortcuts: r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) })
        },
      },
      {
        name: 'shortcuts.run',
        group: 'shortcuts',
        title: '运行快捷指令',
        titleEn: 'Run shortcut',
        description: 'Run a shortcut by name (from shortcuts.list) with optional text input; returns its text output (up to 64 KB). Shortcuts can do almost anything, so every run must be confirmed by the person: without confirmed: true it returns needs_confirmation.',
        risk: 'high',
        confirm: 'always',
        input_schema: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, input: { type: 'string' }, [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean' } },
          additionalProperties: false,
        },
        validate: (args) => (str(args, 'name') ? null : 'name is required'),
        question: (args) => `要在这台电脑上运行快捷指令「${str(args, 'name')}」吗？`,
        async run(args, ctx) {
          const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gugu-shortcut-'))
          try {
            const output = path.join(dir, 'out.txt')
            const cli = ['run', str(args, 'name'), '--output-path', output]
            if (typeof args.input === 'string') {
              const input = path.join(dir, 'in.txt')
              await fsp.writeFile(input, args.input)
              cli.push('--input-path', input)
            }
            ctx.note(`正在运行快捷指令「${str(args, 'name')}」…`)
            const r = await ctx.deps.exec(SHORTCUTS, cli, { signal: ctx.signal, timeoutMs: 280_000 })
            if (r.code !== 0) return fail('execution_failed', `shortcut did not run: ${(r.stderr || r.stdout).trim().slice(0, 400)}`)
            const text = await fsp.readFile(output, 'utf8').catch(() => '')
            return ok({ ran: str(args, 'name'), output: text.slice(0, 65_536), truncated: text.length > 65_536 })
          } finally {
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
          }
        },
      },
    ],
  }
}

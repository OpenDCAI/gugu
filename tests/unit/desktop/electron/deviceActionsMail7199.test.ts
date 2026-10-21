// #7199 邮件(mail.* 12 个):JXA 驱动「邮件」。验:清单与确认策略、脚本能编译、连接时碰系统授权、
// 列表的默认时间窗与上限、发信的确认(存草稿不问)/ 附件只认连上的位置、删信问句念主题、正文预览的短超时。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createMailFamily, MAIL_JXA_LIB, MAIL_SCRIPTS } from '../../../../apps/desktop/electron/device-actions/families/mail'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { MacScriptPermissionError, type ExecResult } from '../../../../apps/desktop/electron/device-actions/mac-scripts'
import type { CuaClient } from '../../../../apps/desktop/electron/device-actions/native/cua-client'
import type { MacHelperClient } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

let dir: string
let home: string
const realHome = process.env.HOME
const NOW = new Date('2026-10-15T10:00:00+08:00')

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-mail-'))
  home = path.join(dir, 'home')
  for (const d of ['Desktop', 'Documents', 'Downloads']) fs.mkdirSync(path.join(home, d), { recursive: true })
  fs.writeFileSync(path.join(home, 'Documents', '报价.pdf'), 'pdf')
  fs.writeFileSync(path.join(home, 'Desktop', 'secret.txt'), 'x')
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(dir, { recursive: true, force: true })
})

type Jxa = (script: string, input: unknown, options: { signal?: AbortSignal; timeoutMs?: number; app: string }) => Promise<unknown>

function setup(jxaImpl: Jxa, mailRunning = true) {
  const store = createDeviceActionGrantsStore(path.join(dir, 'grants.json'))
  const jxa = vi.fn(jxaImpl)
  const exec = vi.fn(async (file: string, _args: readonly string[]): Promise<ExecResult> => ({ stdout: '', stderr: '', code: file === '/usr/bin/pgrep' ? (mailRunning ? 0 : 1) : 0 }))
  const deps: FamilyDeps = {
    platform: 'darwin',
    nativeDir: null,
    now: () => NOW,
    homedir: () => home,
    clipboardRead: () => '',
    clipboardWrite: () => undefined,
    notify: () => undefined,
    openExternal: async () => undefined,
    trashItem: async () => undefined,
    jxa: jxa as unknown as FamilyDeps['jxa'],
    exec,
    macHelper: () => ({ available: () => ({ ok: true }), call: vi.fn(), dispose: () => undefined }) as unknown as MacHelperClient,
    cua: () => ({ available: () => ({ ok: true }), callTool: vi.fn(), stop: () => undefined, dispose: () => undefined }) as unknown as CuaClient,
  }
  const da = createDeviceActionsProvider({ store, families: [createMailFamily()], deps })
  store.setGroup('mail', true)
  return { da, store, jxa, exec }
}

const ctx = () => ({ callId: 'c', signal: new AbortController().signal, note: () => undefined })
/** 这一次 jxa 调的是哪个脚本(按脚本正文认)。 */
const ran = (jxa: ReturnType<typeof vi.fn>, script: string) => jxa.mock.calls.filter(([s]) => s === MAIL_JXA_LIB + script)

describe('邮件 mail.*', () => {
  it('登记 12 个工具;发出去 / 删掉的要确认,发信按「真发才问」', () => {
    const { da } = setup(async () => ({}))
    const actions = da.capability()!.actions
    expect(actions.map((a) => a.name).sort()).toEqual([
      'mail.accounts.list', 'mail.forward', 'mail.mailboxes.list', 'mail.messages.contentPreview.get', 'mail.messages.delete', 'mail.messages.find',
      'mail.messages.get', 'mail.messages.list', 'mail.messages.mark', 'mail.messages.move', 'mail.reply', 'mail.send',
    ])
    const policy = Object.fromEntries(actions.map((a) => [a.name, a.confirm]))
    expect(policy).toMatchObject({ 'mail.send': 'on_conflict', 'mail.reply': 'always', 'mail.forward': 'always', 'mail.messages.delete': 'always', 'mail.messages.list': 'never' })
    for (const a of actions) {
      expect(a.group).toBe('mail')
      expect(a.input_schema).toMatchObject({ type: 'object', additionalProperties: false })
      if (a.confirm !== 'never') expect((a.input_schema.properties as Record<string, unknown>).confirmed).toBeTruthy()
    }
  })

  it.runIf(process.platform === 'darwin' && fs.existsSync('/usr/bin/osacompile'))('每个 JXA 脚本都能编译(❌ 转义写坏)', () => {
    for (const [name, script] of Object.entries(MAIL_SCRIPTS)) {
      const file = path.join(dir, `${name}.js`)
      fs.writeFileSync(file, MAIL_JXA_LIB + script)
      expect(() => execFileSync('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', path.join(dir, `${name}.scpt`), file], { stdio: 'pipe' }), name).not.toThrow()
    }
  })

  it('连接:先在后台隐藏启动「邮件」,再碰一下账户;系统不让 → os_permission + 自动化设置页,❌ 记成连上', async () => {
    const denied = setup(async () => { throw new MacScriptPermissionError('邮件', '-1743') }, false)
    denied.store.setGroup('mail', false)
    const r = await denied.da.connect('mail')
    expect(r).toMatchObject({ ok: false, code: 'os_permission' })
    expect(!r.ok && r.settingsUrl).toContain('Privacy_Automation')
    expect(denied.store.read().groups.mail).toBeUndefined()
    expect(denied.exec.mock.calls.map(([f, a]) => [f, ...a])).toEqual([['/usr/bin/pgrep', '-x', 'Mail'], ['/usr/bin/open', '-g', '-j', '-b', 'com.apple.mail']])

    const fine = setup(async () => ({ accounts: 2 }))
    fine.store.setGroup('mail', false)
    expect(await fine.da.connect('mail')).toEqual({ ok: true })
    expect(fine.jxa.mock.calls[0]![0]).toContain("Application('Mail').accounts.name()")
    expect(fine.jxa.mock.calls[0]![2]).toMatchObject({ app: '邮件' })
    // 「邮件」开着(pgrep 找到)就不再 open(❌ 把人正在用的窗口藏掉)。
    expect(fine.exec.mock.calls.some(([f]) => f === '/usr/bin/open')).toBe(false)
  })

  it('列邮件:默认最近 30 天、25 封,limit 封顶 200;找不到邮箱 → invalid_args 并列出有哪些', async () => {
    const { da, jxa } = setup(async (_s, input) => ((input as { mailbox?: string }).mailbox === '不存在'
      ? { error: 'mailbox_not_found', available: ['INBOX', 'Sent Messages'] }
      : { total_matched: 40, messages: [{ id: 7, subject: '周报' }] }))
    const r = await da.provider.run('mail.messages.list', {}, ctx())
    expect(r).toMatchObject({ ok: true, data: { total_matched: 40, returned: 1, truncated: true } })
    expect(ran(jxa, MAIL_SCRIPTS.list)[0]![1]).toEqual({
      mailbox: undefined, accountId: undefined, unreadOnly: false, since: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(), subject: undefined, sender: undefined, limit: 25,
    })
    await da.provider.run('mail.messages.find', { sender: 'boss', limit: 999, since: '2026-10-01T00:00:00+08:00' }, ctx())
    expect(ran(jxa, MAIL_SCRIPTS.list)[1]![1]).toMatchObject({ sender: 'boss', limit: 200, since: '2026-09-30T16:00:00.000Z' })
    const missing = await da.provider.run('mail.messages.list', { mailbox: '不存在' }, ctx())
    expect(missing).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('INBOX, Sent Messages') })
    expect(await da.provider.preflight!('mail.messages.find', {})).toMatchObject({ code: 'invalid_args' })
    expect(await da.provider.preflight!('mail.messages.list', { since: '昨天' })).toMatchObject({ code: 'invalid_args' })
  })

  it('发信:真发先回 needs_confirmation,问句写清用哪个地址发给谁、什么主题;❌ 先发', async () => {
    const { da, jxa } = setup(async (script) => (script.endsWith(MAIL_SCRIPTS.accounts)
      ? { accounts: [{ id: 'A1', emails: ['me@work.com'] }] }
      : { sent: true, sender: 'me@work.com' }))
    const args = { to: ['boss@corp.com'], cc: ['hr@corp.com'], subject: '周报', content: '本周完成了……', fromAccountId: 'A1' }
    expect(await da.provider.preflight!('mail.send', args)).toBeNull()
    const first = await da.provider.run('mail.send', args, ctx())
    expect(first).toMatchObject({ ok: false, code: 'needs_confirmation', confirm: { question: '要用「me@work.com」给 boss@corp.com 发主题为「周报」的邮件吗？（抄送 hr@corp.com）' } })
    expect(ran(jxa, MAIL_SCRIPTS.send)).toHaveLength(0)
    const second = await da.provider.run('mail.send', { ...args, confirmed: true }, ctx())
    expect(second).toMatchObject({ ok: true, data: { sent: true, from: 'me@work.com' } })
    expect(ran(jxa, MAIL_SCRIPTS.send)[0]![1]).toEqual({ to: ['boss@corp.com'], cc: ['hr@corp.com'], bcc: [], subject: '周报', content: '本周完成了……', sender: 'me@work.com', attachments: [], send: true })
  })

  it('发信:只存草稿不问人;收件人不是邮箱 → 开工前 invalid_args;账户 id 不存在 → invalid_args', async () => {
    const { da, jxa } = setup(async (script) => (script.endsWith(MAIL_SCRIPTS.accounts) ? { accounts: [] } : { sent: false }))
    const draft = await da.provider.run('mail.send', { to: ['a@b.com'], subject: '草稿', sendImmediately: false }, ctx())
    expect(draft).toMatchObject({ ok: true, data: { sent: false, saved_as_draft: true } })
    expect(ran(jxa, MAIL_SCRIPTS.send)[0]![1]).toMatchObject({ send: false })
    expect(await da.provider.preflight!('mail.send', { to: ['张三'] })).toMatchObject({ code: 'invalid_args', message: expect.stringContaining('张三') })
    expect(await da.provider.preflight!('mail.send', { to: [] })).toMatchObject({ code: 'invalid_args' })
    expect(await da.provider.run('mail.send', { to: ['a@b.com'], fromAccountId: 'nope' }, ctx())).toMatchObject({ ok: false, code: 'invalid_args' })
  })

  it('发信附件:没连任何文件位置 → not_granted 并说去连哪组;只认连上的位置;传给「邮件」的是真实路径', async () => {
    const { da, store, jxa } = setup(async () => ({ sent: false }))
    const args = { to: ['a@b.com'], attachments: ['~/Documents/报价.pdf'], sendImmediately: false }
    const none = await da.provider.run('mail.send', args, ctx())
    expect(none).toMatchObject({ ok: false, code: 'not_granted', message: expect.stringContaining('Desktop / Documents / Downloads / Other locations') })
    store.setGroup('files.documents', true)
    expect(await da.provider.run('mail.send', args, ctx())).toMatchObject({ ok: true })
    expect(ran(jxa, MAIL_SCRIPTS.send)[0]![1]).toMatchObject({ attachments: [fs.realpathSync(path.join(home, 'Documents', '报价.pdf'))] })
    expect(await da.provider.run('mail.send', { ...args, attachments: ['~/Desktop/secret.txt'] }, ctx())).toMatchObject({ ok: false, code: 'invalid_args' })
  })

  it('删信:问句念出每封的主题;主题与 id 数目对不上 → invalid_args;确认后把主题交给脚本逐封核对', async () => {
    const { da, jxa } = setup(async () => ({ results: [{ id: 3, deleted: true }, { id: 4, deleted: false, error: 'subject is "x"' }] }))
    const args = { messageIds: [3, 4], subjects: ['发票', '会议纪要'] }
    expect(await da.provider.preflight!('mail.messages.delete', args)).toMatchObject({ code: 'needs_confirmation', confirm: { question: '要把这 2 封邮件移到废纸篓吗？「发票」「会议纪要」' } })
    expect(await da.provider.preflight!('mail.messages.delete', { messageIds: [3, 4], subjects: ['发票'] })).toMatchObject({ code: 'invalid_args' })
    const r = await da.provider.run('mail.messages.delete', { ...args, confirmed: true }, ctx())
    expect(r).toMatchObject({ ok: true, data: { deleted: 1, total: 2 } })
    expect(ran(jxa, MAIL_SCRIPTS.delete)[0]![1]).toEqual({ messageIds: [3, 4], subjects: ['发票', '会议纪要'] })
  })

  it('回复 / 转发:问句念原信主题与去向;原信主题对不上 → invalid_args,什么都没发', async () => {
    const { da } = setup(async () => ({ error: 'subject_mismatch', subject: '别的信' }))
    expect(await da.provider.preflight!('mail.reply', { messageId: 9, subject: '周报', content: '收到，谢谢' }))
      .toMatchObject({ code: 'needs_confirmation', confirm: { question: '要给邮件「周报」的发件人发一封回复吗？回复内容「收到，谢谢」' } })
    expect(await da.provider.preflight!('mail.forward', { messageId: 9, subject: '周报', to: ['x@y.com'] }))
      .toMatchObject({ code: 'needs_confirmation', confirm: { question: '要把邮件「周报」转发给 x@y.com 吗？' } })
    const r = await da.provider.run('mail.reply', { messageId: 9, subject: '周报', confirmed: true }, ctx())
    expect(r).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('别的信') })
  })

  it('正文预览:到点没回 → content_status timeout(❌ 等满整个调用);截断如实标出', async () => {
    const slow = setup((_s, _i, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('killed')), { once: true })
    }))
    const started = Date.now()
    const r = await slow.da.provider.run('mail.messages.contentPreview.get', { messageId: 5, timeoutMs: 1000 }, ctx())
    expect(r).toMatchObject({ ok: true, data: { id: 5, content_status: 'timeout', content: null } })
    expect(Date.now() - started).toBeLessThan(4000)

    const fast = setup(async () => ({ status: 'ok', content: 'a'.repeat(1200), content_length: 5000 }))
    const r2 = await fast.da.provider.run('mail.messages.contentPreview.get', { messageId: 5 }, ctx())
    expect(r2).toMatchObject({ ok: true, data: { content_status: 'ok', content_length: 5000, truncated: true } })
    expect(fast.jxa.mock.calls[0]![1]).toMatchObject({ messageId: 5, maxContentLength: 1200 })
  })

  it('跑的时候系统收回了授权 → os_permission,这一组在清单里标成系统权限不可用', async () => {
    const { da } = setup(async () => { throw new MacScriptPermissionError('邮件', '-1743') })
    expect(await da.provider.run('mail.accounts.list', {}, ctx())).toMatchObject({ ok: false, code: 'os_permission' })
    expect(da.capability()!.actions.find((a) => a.name === 'mail.accounts.list')).toMatchObject({ available: false, unavailable_reason: 'os_permission' })
    expect(da.blocked('mail')).toMatchObject({ reason: 'os_permission' })
  })
})

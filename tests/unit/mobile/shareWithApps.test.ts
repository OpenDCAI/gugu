// @@@share-with-apps 与其他 App 互传(product spec)。
//
// 原生插件只搬运,判据在渲染层 —— 这里判的是判据:一条消息交出去的是什么、分享进来的内容接到哪条草稿上、
// 「发送到」页列哪些会话;以及安卓壳那一侧有没有接上(插件注册、intent-filter、FileProvider 目录、拒收的地址)。
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../../packages/core/src/shared/types/chat'
import { formatAttachmentMetadata } from '../../../packages/core/src/shared/ui/attachmentModels'
import { formatVoiceAttachmentMetadata } from '../../../packages/core/src/shared/ui/voiceAttachmentModels'
import { resolveSharePlan, sharePayloadForMessage, sharePayloadForMessages } from '../../../apps/desktop/src/lib/shareToApps'
import { mergeShareIntoDraft, shareTargetChats } from '../../../apps/desktop/src/mobile/share-intake/shareTargets'
import type { IncomingShare } from '../../../apps/desktop/src/platform/types'

const native = vi.hoisted(() => ({
  listeners: [] as Array<(share: unknown) => void>,
  release: vi.fn(async (_options: { id: string }) => {}),
  share: vi.fn(async (_options: unknown) => {}),
  open: vi.fn(async (_options: { url: string; name: string }) => {}),
  save: vi.fn(async (_options: { name: string; mimeType: string; data: string }) => ({ saved: true })),
}))

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    share: native.share,
    open: native.open,
    save: native.save,
    release: native.release,
    addListener: async (_event: string, listener: (share: unknown) => void) => {
      native.listeners.push(listener)
      return { remove: async () => { native.listeners.splice(native.listeners.indexOf(listener), 1) } }
    },
  }),
  Capacitor: { convertFileSrc: (path: string) => path.replace('file://', 'https://localhost/_capacitor_file_') },
}))

// 让掉一轮宏任务:只用来等**纯微任务**的尾巴(注册监听、promise 链收口)。
// 读分享进来的文件(fetch → Response.blob())不是微任务 —— 实测 blob 落在同一轮的 setTimeout(0)、setImmediate
// 之后 —— 那一段等它自己交出的事实(界面收到分享、原生被叫去删副本),❌ 数让掉几轮。
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('一条消息交给系统分享面板的是什么', () => {
  const image = formatAttachmentMetadata({ kind: 'image', fileName: 'cat.png', mimeType: 'image/png', url: 'https://storage.example/chat-media/cat.png', sizeBytes: 10 })

  it('文字消息发文字', () => {
    expect(sharePayloadForMessage({ content_type: 'text', content: '晚上七点见' })).toEqual({ text: '晚上七点见' })
  })

  it('图片发图片本身(地址交给宿主去取),不是链接文字', () => {
    expect(sharePayloadForMessage({ content_type: 'attachment', content: image })).toEqual({
      files: [{ source: { kind: 'url', url: 'https://storage.example/chat-media/cat.png' }, name: 'cat.png', mimeType: 'image/png' }],
    })
  })

  it('附件带附言时附言随行', () => {
    const file = formatAttachmentMetadata({ kind: 'file', fileName: '周报.pdf', mimeType: 'application/pdf', url: 'https://storage.example/r.pdf', sizeBytes: 99, caption: '请看第三页' })
    expect(sharePayloadForMessage({ content_type: 'attachment', content: file })).toEqual({
      files: [{ source: { kind: 'url', url: 'https://storage.example/r.pdf' }, name: '周报.pdf', mimeType: 'application/pdf' }],
      text: '请看第三页',
    })
  })

  // 群文件夹里的附件(#7290):先记来源,点「分享」那一刻才签成链接(安卓原生按链接下);条目删了的不出这一行。
  it('群文件夹里的附件:记来源,点下去才签;条目删了分享不了', async () => {
    const envelope = '[附件] cat.png (image/png)\n[Size] 10\n[Kind] image'
    const plan = sharePayloadForMessage({ content_type: 'attachment', content: envelope, file_item_id: 'item-1', file_version: 2 })
    expect(plan).toEqual({ files: [{ source: { kind: 'item', itemId: 'item-1', version: 2 }, name: 'cat.png', mimeType: 'image/png' }] })
    const asked: unknown[] = []
    expect(await resolveSharePlan(plan!, async (source) => { asked.push(source); return { status: 'ready', url: 'https://cdn.example/ab/sig', thumbUrl: null, sha256: null, width: null, height: null } }))
      .toEqual({ files: [{ url: 'https://cdn.example/ab/sig', name: 'cat.png', mimeType: 'image/png' }] })
    expect(asked).toEqual([{ kind: 'item', itemId: 'item-1', version: 2 }])
    await expect(resolveSharePlan(plan!, async () => ({ status: 'gone' }))).rejects.toThrow('cat.png was deleted')
    expect(sharePayloadForMessage({ content_type: 'attachment', content: envelope, file_item_id: null, file_version: 2 })).toBeNull()
  })

  it('分享不了的返回 null:语音(没有文件地址)、卡片、空白、长得像附件的普通文字', () => {
    expect(sharePayloadForMessage({ content_type: 'attachment', content: formatVoiceAttachmentMetadata(3000, '你好') })).toBeNull()
    expect(sharePayloadForMessage({ content_type: 'card', content: '{"x":1}' })).toBeNull()
    expect(sharePayloadForMessage({ content_type: 'text', content: '   ' })).toBeNull()
    expect(sharePayloadForMessage({ content_type: 'text', content: null })).toBeNull()
    // 判型看 content_type,不看正文长相:文字消息里贴了一段附件格式,照样按文字发。
    expect(sharePayloadForMessage({ content_type: 'text', content: image })).toEqual({ text: image })
  })
})

describe('多选转发时一起交出去的是什么', () => {
  const image = formatAttachmentMetadata({ kind: 'image', fileName: 'a.png', mimeType: 'image/png', url: 'https://storage.example/a.png', sizeBytes: 1 })

  it('文字按顺序空一行接起来,附件依次排开', () => {
    expect(sharePayloadForMessages([
      { content_type: 'text', content: '第一句' },
      { content_type: 'attachment', content: image },
      { content_type: 'text', content: '第二句' },
    ])).toEqual({
      text: '第一句\n\n第二句',
      files: [{ source: { kind: 'url', url: 'https://storage.example/a.png' }, name: 'a.png', mimeType: 'image/png' }],
    })
  })

  it('有一条分享不了(语音、卡片)就整组不给 —— ❌ 悄悄漏掉其中一条', () => {
    expect(sharePayloadForMessages([
      { content_type: 'text', content: '能分享' },
      { content_type: 'attachment', content: formatVoiceAttachmentMetadata(1000, '语音') },
    ])).toBeNull()
    expect(sharePayloadForMessages([])).toBeNull()
  })
})

describe('「发送到」页列哪些会话', () => {
  const chat = (patch: Partial<ChatItem>): ChatItem => ({
    id: 'x', kind: 'dm', name: null, peer_user_id: null, last_message_at: null, created_at: '2026-09-01T00:00:00Z', unread_count: 0, ...patch,
  }) as ChatItem
  const chats = [
    chat({ id: 'old', name: '老群', kind: 'group', last_message_at: '2026-09-02T00:00:00Z' }),
    chat({ id: 'new', name: '新单聊', last_message_at: '2026-09-20T00:00:00Z' }),
    chat({ id: 'empty-dm', name: '没说过话' }),
    chat({ id: 'pinned', name: '置顶', last_message_at: '2026-08-01T00:00:00Z', is_pinned: true }),
    chat({ id: 'topic', name: '话题', kind: 'topic', last_message_at: '2026-09-25T00:00:00Z' }),
  ]
  const context = { query: '', displayName: (c: ChatItem) => c.name ?? '', activeChatId: null, drafts: {} }

  it('与会话列表同一个「列不列」判据;话题不在;置顶在前,其余按活动时间', () => {
    expect(shareTargetChats(chats, context).map((c) => c.id)).toEqual(['pinned', 'new', 'old'])
  })

  it('搜索是指名道姓:没说过话的单聊也搜得到,话题仍然不在', () => {
    expect(shareTargetChats(chats, { ...context, query: '没说过' }).map((c) => c.id)).toEqual(['empty-dm'])
    expect(shareTargetChats(chats, { ...context, query: '话题' })).toEqual([])
  })

  it('有草稿的空单聊照列(用户留过痕)', () => {
    expect(shareTargetChats(chats, { ...context, drafts: { 'empty-dm': '写了一半' } }).map((c) => c.id)).toContain('empty-dm')
  })
})

describe('分享进来的内容接到那条会话的草稿上', () => {
  const photo = new File(['p'], 'IMG_1.jpg', { type: 'image/jpeg' })
  const doc = new File(['d'], 'a.pdf', { type: 'application/pdf' })
  let n = 0
  const id = () => `id-${++n}`
  beforeEach(() => { n = 0 })

  it('空草稿:文字就是分享的文字,图片与文件各按类型排进待发附件', () => {
    expect(mergeShareIntoDraft({ text: '', attachments: [] }, { text: 'https://example.com', files: [photo, doc] }, id)).toEqual({
      text: 'https://example.com',
      attachments: [{ id: 'id-1', file: photo, kind: 'image' }, { id: 'id-2', file: doc, kind: 'file' }],
    })
  })

  it('❌ 覆盖用户没发出去的草稿:文字另起一行接在后面,附件排在已排队的后面', () => {
    const queued = { id: 'q', file: doc, kind: 'file' as const }
    const merged = mergeShareIntoDraft({ text: '先说一句', attachments: [queued] }, { text: '转来的', files: [photo] }, id)
    expect(merged.text).toBe('先说一句\n转来的')
    expect(merged.attachments.map((a) => a.id)).toEqual(['q', 'id-1'])
  })

  it('只有文件时不动草稿文字', () => {
    expect(mergeShareIntoDraft({ text: '留着', attachments: [] }, { text: null, files: [doc] }, id).text).toBe('留着')
  })
})

describe('安卓壳交过来的分享', () => {
  beforeEach(() => {
    native.listeners.length = 0
    native.release.mockClear()
    native.release.mockImplementation(async () => {})
  })

  it('标题与正文合成一段文字;标题已在正文里就不重复', async () => {
    const { incomingShareText } = await import('../../../apps/desktop/src/platform/capacitorShare')
    expect(incomingShareText('好文章', 'https://example.com/a')).toBe('好文章\nhttps://example.com/a')
    expect(incomingShareText('好文章', '好文章 https://example.com/a')).toBe('好文章 https://example.com/a')
    expect(incomingShareText(null, '  ')).toBeNull()
    expect(incomingShareText('只有标题', null)).toBe('只有标题')
  })

  it('读成 File 交给界面;读不出来的进 failures(❌ 悄悄少一个);读完让原生删掉副本', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/ok.jpg')
      ? new Response(new Blob(['jpeg'], { type: 'image/jpeg' }))
      : new Response('gone', { status: 404 })))
    const { subscribeIncomingShares } = await import('../../../apps/desktop/src/platform/capacitorShare')
    let delivered!: () => void
    const shareDelivered = new Promise<void>((resolve) => { delivered = resolve })
    const received = vi.fn((_share: IncomingShare) => delivered())
    const stop = subscribeIncomingShares(received)
    await flush()
    expect(native.listeners).toHaveLength(1)
    native.listeners[0]!({
      id: '0f8fad5b-d9cb-469f-a165-70867728950e',
      text: null,
      subject: null,
      files: [
        { path: 'file:///data/cache/share-in/x/ok.jpg', name: 'ok.jpg', mimeType: 'image/jpeg', size: 4 },
        { path: 'file:///data/cache/share-in/x/lost.mov', name: 'lost.mov', mimeType: 'video/quicktime', size: 9 },
      ],
      failures: [{ name: 'secret.db', code: 'refused', detail: 'refusing an address inside 咕咕 itself' }],
    })
    await shareDelivered
    expect(received).toHaveBeenCalledTimes(1)
    const share = received.mock.calls[0]![0]
    expect(share.files.map((f: File) => [f.name, f.type])).toEqual([['ok.jpg', 'image/jpeg']])
    // 给界面的是原因代码(挑一句用户看得懂的话),原文只进日志。
    expect(share.failures).toEqual([{ name: 'secret.db', reason: 'refused' }, { name: 'lost.mov', reason: 'unreadable' }])
    expect(native.release).toHaveBeenCalledWith({ id: '0f8fad5b-d9cb-469f-a165-70867728950e' })
    stop()
    await flush()
    expect(native.listeners).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('几份先后到时以最后到的那份为准:先到的大文件读得慢,也不许盖掉后到的那份', async () => {
    let releaseSlow: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/slow.mp4')
      ? new Promise((resolve) => { releaseSlow = () => resolve(new Response(new Blob(['v'], { type: 'video/mp4' }))) })
      : Promise.resolve(new Response(new Blob(['t'], { type: 'text/plain' })))))
    const slowId = 'a0000000-0000-4000-8000-000000000001'
    let slowRead!: () => void
    const slowReadDone = new Promise<void>((resolve) => { slowRead = resolve })
    // 读完一份才叫原生删它的副本:慢的那份被叫去删 = 它的文件已经读完。
    native.release.mockImplementation(async ({ id }) => { if (id === slowId) slowRead() })
    const { subscribeIncomingShares } = await import('../../../apps/desktop/src/platform/capacitorShare')
    let deliveredLater!: () => void
    const laterDelivered = new Promise<void>((resolve) => { deliveredLater = resolve })
    const received = vi.fn((_share: IncomingShare) => deliveredLater())
    const stop = subscribeIncomingShares(received)
    await flush()
    const emit = native.listeners[0]!
    emit({ id: slowId, text: null, subject: null, files: [{ path: 'file:///c/slow.mp4', name: 'slow.mp4', mimeType: 'video/mp4', size: 1 }], failures: [] })
    emit({ id: 'a0000000-0000-4000-8000-000000000002', text: '后到的那份', subject: null, files: [], failures: [] })
    await laterDelivered
    releaseSlow!()
    await slowReadDone
    // 删副本之后,这一份还剩「以最后到的为准」那一步,全在微任务里。
    await flush()
    expect(received.mock.calls.map((call) => call[0].text)).toEqual(['后到的那份'])
    stop()
    vi.unstubAllGlobals()
  })

  it('能力位:只有安卓壳有;浏览器与 Electron 都没有', async () => {
    const [{ capacitorPlatform }, { electronPlatform }, { webPlatform }] = await Promise.all([
      import('../../../apps/desktop/src/platform/capacitor'),
      import('../../../apps/desktop/src/platform/electron'),
      import('../../../apps/desktop/src/platform/web'),
    ])
    expect(capacitorPlatform.capabilities.shareToApps).toBe(true)
    expect(capacitorPlatform.subscribeIncomingShares).toBeTypeOf('function')
    expect(electronPlatform.capabilities.shareToApps).toBe(false)
    expect(webPlatform.capabilities.shareToApps).toBe(false)
  })

  it('应用内不预览的附件:安卓壳把地址交给原生,由原生下好再弹系统「打开方式」', async () => {
    const { capacitorPlatform } = await import('../../../apps/desktop/src/platform/capacitor')
    expect(capacitorPlatform.capabilities.externalFileOpen).toBe(true)
    // 安卓要签名链接(原生自己下),不要字节:宿主只调 url()。
    await capacitorPlatform.openRemoteFile({ bytes: async () => { throw new Error('the Android shell does not take bytes') }, url: async () => 'https://storage.example/chat-media/a.zip' }, '素材.zip')
    expect(native.open).toHaveBeenCalledWith({ url: 'https://storage.example/chat-media/a.zip', name: '素材.zip' })
  })

  it('「保存」:WebView 不接 a[download],安卓壳把这份字节原样(base64)交给原生的「保存到…」;取消是 saved:false', async () => {
    const { capacitorPlatform } = await import('../../../apps/desktop/src/platform/capacitor')
    // node 里没有 FileReader(WebView 里有):按它的契约补一个最小的 —— readAsDataURL 交出 data:<type>;base64,<…>。
    vi.stubGlobal('FileReader', class {
      result: string | null = null
      error: Error | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((buffer) => {
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`
          this.onload?.()
        })
      }
    })
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    await expect(capacitorPlatform.saveFile(new Blob([bytes], { type: 'image/svg+xml' }), 'a.svg')).resolves.toEqual({ saved: true })
    const sent = native.save.mock.calls.at(-1)![0]
    expect([sent.name, sent.mimeType]).toEqual(['a.svg', 'image/svg+xml'])
    expect([...Buffer.from(sent.data, 'base64')]).toEqual([...bytes])
    native.save.mockResolvedValueOnce({ saved: false })
    await expect(capacitorPlatform.saveFile(new Blob(['x']), 'b.txt')).resolves.toEqual({ saved: false })
    vi.unstubAllGlobals()
  })
})

describe('原生那一侧接上了', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  const plugin = read('apps/mobile/android/app/src/main/java/app/gugu/chat/GuguSharePlugin.java')
  const manifestXml = read('apps/mobile/android/app/src/main/AndroidManifest.xml')

  it('插件注册了,名字与 TS 这一侧 registerPlugin 的一致', () => {
    expect(read('apps/mobile/android/app/src/main/java/app/gugu/chat/MainActivity.java')).toContain('registerPlugin(GuguSharePlugin.class)')
    expect(plugin).toContain('@CapacitorPlugin(name = "GuguShare")')
    expect(read('apps/desktop/src/platform/capacitorShare.ts')).toContain("registerPlugin<GuguSharePlugin>('GuguShare')")
    expect(plugin).toContain('static final String EVENT_RECEIVED = "shareReceived"')
    expect(read('apps/desktop/src/platform/capacitorShare.ts')).toContain("addListener('shareReceived'")
  })

  it('分享出去的附件目录经 FileProvider 开放 —— 两处目录名必须是同一个', () => {
    const dir = /private static final String OUT_DIR = "([^"]+)"/.exec(plugin)?.[1]
    expect(dir).toBe('share-out')
    expect(read('apps/mobile/android/app/src/main/res/xml/file_paths.xml')).toContain(`<cache-path name="share_out" path="${dir}/" />`)
  })

  it('别的 App 的「分享」与微信的「用其他应用打开」都落到主 Activity', () => {
    const filters = manifestXml.match(/<intent-filter[\s\S]*?<\/intent-filter>/g) ?? []
    const has = (action: string, data: RegExp) => filters.some((f) => f.includes(`android.intent.action.${action}`) && f.includes('android.intent.category.DEFAULT') && data.test(f))
    expect(has('SEND', /android:mimeType="\*\/\*"/)).toBe(true)
    expect(has('SEND_MULTIPLE', /android:mimeType="\*\/\*"/)).toBe(true)
    const view = filters.find((f) => f.includes('action.VIEW') && f.includes('android:scheme="content"'))
    expect(view).toBeDefined()
    // 只认真文件的五个大类:*/* 会连文件夹、存储根(vnd.android.document/*)一起匹配。
    expect(view!.match(/android:mimeType="([^"]+)"/g)).toEqual(['application/*', 'image/*', 'video/*', 'audio/*', 'text/*'].map((t) => `android:mimeType="${t}"`))
    // 「打开方式」里那一项叫「发送到咕咕」,资源由 build.gradle 按档位生成。
    expect(filters.find((f) => f.includes('action.VIEW'))).toContain('android:label="@string/share_target_open_with"')
    expect(read('apps/mobile/android/app/build.gradle')).toMatch(/resValue "string", "share_target_open_with", "发送到\$\{guguAppLabel\}"/)
  })

  it('「打开方式」与分享同一个下载目录;两个选择器都不列咕咕自己(咕咕认 VIEW content://)', () => {
    expect(plugin).toMatch(/public void open\(PluginCall call\)[\s\S]*?new File\(getContext\(\)\.getCacheDir\(\), OUT_DIR\)[\s\S]*?new Intent\(Intent\.ACTION_VIEW\)[\s\S]*?FLAG_GRANT_READ_URI_PERMISSION[\s\S]*?startChooser\(call, view, null\)/)
    expect(plugin).toMatch(/startChooser\(call, send, title\)/)
    expect(plugin).toMatch(/private void startChooser[\s\S]*?EXTRA_EXCLUDE_COMPONENTS, new ComponentName\[\] \{ new ComponentName\(getContext\(\), MainActivity\.class\) \}/)
  })

  it('只收 content://,且拒收咕咕自己的提供方 —— 带用户号前缀(0@…)的地址也按提供方所属包认', () => {
    expect(plugin).toMatch(/if \(!ContentResolver\.SCHEME_CONTENT\.equals\(uri\.getScheme\(\)\)\) \{\s*throw new Rejected\("refused"/)
    expect(plugin).toMatch(/if \(isOwnProvider\(uri\)\) \{\s*throw new Rejected\("refused"/)
    expect(plugin).toMatch(/authority\.substring\(authority\.lastIndexOf\('@'\) \+ 1\)/)
    expect(plugin).toMatch(/resolveContentProvider\(bare, 0\)/)
  })

  it('超过 100 MB 的不拷:声明的大小先挡一次,拷的过程中再截一次', () => {
    expect(plugin).toContain('MAX_INCOMING_BYTES = 100L * 1024 * 1024')
    expect(plugin).toMatch(/if \(declaredSize > MAX_INCOMING_BYTES\) throw new Rejected\("tooLarge"/)
    expect(plugin).toMatch(/if \(size > MAX_INCOMING_BYTES\) throw new Rejected\("tooLarge"/)
    // 原因代码随失败一起交给页面,原文只放 detail(进日志)。
    expect(plugin).toMatch(/failure\.put\("code", error instanceof Rejected \? \(\(Rejected\) error\)\.code : "unreadable"\)/)
  })

  it('进程被杀后恢复 / 从「最近任务」重开,不重放当初那个分享 Intent', () => {
    const activity = read('apps/mobile/android/app/src/main/java/app/gugu/chat/MainActivity.java')
    expect(activity).toMatch(/savedInstanceState != null \|\| \(getIntent\(\)\.getFlags\(\) & Intent\.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY\) != 0/)
    expect(activity).toMatch(/GuguSharePlugin\.isIncoming\(getIntent\(\)\)\) \{\s*setIntent\(new Intent\(Intent\.ACTION_MAIN\)\)/)
    // 必须在 super.onCreate(插件 load 读 launch intent)之前。
    expect(activity.indexOf('FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY')).toBeLessThan(activity.indexOf('super.onCreate'))
  })
})

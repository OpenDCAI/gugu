/**
 * 粘贴的东西怎么进输入框（#5269，owner 2026-09-08 定的两条预期）。
 *
 * 判据都在真 DOM 上：构造真的 `ClipboardEvent` + `DataTransfer` 派发到编辑器，读 composer
 * 实际调出去的回调。⚠️ 两条反向对照是这组测试的重点，不是凑数：
 *   · 短文本必须**照常进编辑器**——否则「长文本转文件」会变成「粘贴全被吞」；
 *   · 宿主没有收文件的口子时，长文本也必须照常进编辑器——那种情况下拦截 = 用户的文字凭空消失。
 * 少了这两条，只测「长文本变文件」的那一条在「无脑吞掉一切粘贴」的实现下同样会绿。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatComposer, PASTED_TEXT_AS_FILE_MIN_CHARS, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import '@/styles/tokens.css'
import '@renderer/index.css'
import { until } from '../../../../../../../tests/support/awaitCondition'

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  root?.unmount()
  root = null
  host?.remove()
  host = null
})

type Seen = { images: File[][]; files: File[][] }

function mount(props: Record<string, unknown>): Seen {
  host = document.createElement('div')
  host.className = 'gugu-skin'
  document.body.appendChild(host)
  const seen: Seen = { images: [], files: [] }
  root = createRoot(host)
  root.render(
    <SessionLocalizationProvider>
      <ChatComposer
        onImageFilesDropped={(f) => seen.images.push(f)}
        onAttachmentsChange={() => {}}
        onSubmit={() => {}}
        {...props}
      />
    </SessionLocalizationProvider>,
  )
  return seen
}

/** 首帧是排程出去的:ProseMirror 视图(contenteditable,构造时即挂上 paste 监听)进了 DOM 才算挂好。 */
const mounted = () => host?.querySelector('[contenteditable="true"]') != null

/**
 * ProseMirror 没从 clipboardData 里解析出任何东西时(只带文件的粘贴),会走 `capturePaste`:往编辑器
 * 父节点塞一个 `left:-10000px` 的临时 contenteditable,50ms 后在**同一个回调里**先摘掉它、再 doPaste
 * 它的内容(prosemirror-view dist/index.js `capturePaste`)。它不在了 = 那一手迟到的插入已经做完。
 */
const pasteCaptureDone = (editable: HTMLElement) =>
  editable.parentElement?.querySelector(':scope > [style*="-10000px"]') == null

function paste(text?: string, file?: File, html?: string) {
  const dt = new DataTransfer()
  if (file) dt.items.add(file)
  if (text !== undefined) dt.setData('text/plain', text)
  if (html !== undefined) dt.setData('text/html', html)
  const editable = host!.querySelector<HTMLElement>('[contenteditable="true"]')!
  editable.focus()
  const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  editable.dispatchEvent(event)
  return { event, editable }
}

const longText = 'x'.repeat(PASTED_TEXT_AS_FILE_MIN_CHARS + 1)

describe('composer paste (#5269)', () => {
  const url = 'https://www.recode.cat/cli/auth?state=cw479-test&p=claude'
  it.each([
    ['plain text', undefined],
    ['an HTML link title', `<a href="${url.replace('&', '&amp;')}">Recode sign-in</a>`],
  ])('keeps the original URL when the clipboard includes %s', async (_format, html) => {
    const submitted: string[] = []
    const editor: { current: PromptEditorRef | null } = { current: null }
    mount({ editorApiRef: editor, onSubmit: (text: string) => submitted.push(text) })
    await until('编辑器挂载', () => mounted() && editor.current != null)
    const { editable } = paste(url, undefined, html)
    await until('粘贴已进入正文', () => !!editor.current?.getText())

    expect(editor.current!.getText()).toBe(url)
    editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    await until('原样链接已提交', () => submitted.length > 0)
    expect(submitted).toEqual([url])
  })

  it('restores a canonical file reference through the existing mention provider', async () => {
    const editor: { current: PromptEditorRef | null } = { current: null }
    const path = '/workspace/report.md'
    const text = `Check @[report.md](${path})`
    mount({ editorApiRef: editor, mentionProvider: {
      search: async () => [],
      resolve: (target: string, label: string) => target === path
        ? { id: target, label: target, name: label, kind: 'file' } : null,
    } })
    await until('编辑器挂载', () => mounted() && editor.current != null)
    const { editable } = paste(text, undefined, '<a href="/workspace/report.md">Report</a>')

    await until('文件引用已绘制', () => editable.querySelector(`[data-mention-id="${path}"]`) != null)
    expect(editable.querySelector(`[data-mention-id="${path}"]`)).not.toBeNull()
    expect(editor.current!.getText()).toBe(text)
  })

  it('长文本 → 一个 .txt 文件，正文不进编辑器', async () => {
    const seen = mount({ onFilesDropped: (f: File[]) => seen.files.push(f) })
    await until('编辑器挂载', () => mounted())
    const { event, editable } = paste(longText)
    await until('文件通道收到一次', () => seen.files.length > 0)

    expect(seen.files).toHaveLength(1)
    const [file] = seen.files[0]!
    expect(file.name).toBe('pasted-text.txt')
    expect(file.type).toBe('text/plain')
    expect(await file.text()).toBe(longText)
    // ⚠️ 判据是编辑器里**没有**这段文字,❌ 不是 `event.defaultPrevented` —— ProseMirror 自己
    // 处理粘贴时也会 preventDefault,那个读数对「谁收走了它」一句话都没说。
    // 文件通道已响 ⇒ 编辑器的 handlePaste 已同步返回 true(packages/session-ui/src/react/components/
    // prompt-editor/prompt-editor.tsx:369-374),ProseMirror 在 doPaste 里当场止步、不 dispatch:正文此刻即终局。
    expect(editable.innerText.trim()).toBe('')
    expect(event.type).toBe('paste')
  })

  it('反向对照 ①：刚好没到阈值的文本照常进编辑器，不变文件', async () => {
    const files: File[][] = []
    mount({ onFilesDropped: (f: File[]) => files.push(f) })
    await until('编辑器挂载', () => mounted())
    const short = 'y'.repeat(PASTED_TEXT_AS_FILE_MIN_CHARS - 1)
    const { editable } = paste(short)
    await until('短文本进了编辑器', () => editable.innerText.includes('yyy'))
    // 文字能进编辑器,是因为 handlePastedText 已同步返回 false(packages/session-ui/src/react/components/
    // chat-composer/index.tsx:477-482)—— 要变文件只可能发生在那之前:文件通道此刻没响即终局。

    expect(files).toHaveLength(0)
    expect(editable.innerText).toContain('yyy')
  })

  it('反向对照 ②：宿主收不了文件时，长文本照常进编辑器（❌ 不许吞）', async () => {
    mount({})
    await until('编辑器挂载', () => mounted())
    const { editable } = paste(longText)
    await until('长文本进了编辑器', () => editable.innerText.length > 100)

    expect(editable.innerText.length).toBeGreaterThan(100)
  })

  it('粘贴图片 → 走附件路径，不落进正文', async () => {
    const seen = mount({ onFilesDropped: () => {} })
    await until('编辑器挂载', () => mounted())
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
    const { editable } = paste(undefined, png)
    await until('图片通道收到一次', () => seen.images.length > 0)
    // 正文那一侧不是同步终局:只带文件的粘贴会让 ProseMirror 走 capturePaste(见 pasteCaptureDone)。
    await until('ProseMirror 的粘贴捕获收尾', () => pasteCaptureDone(editable))

    expect(seen.images).toHaveLength(1)
    expect(seen.images[0]!.map((f) => f.name)).toEqual(['shot.png'])
    expect(editable.innerText.trim()).toBe('')
  })
})

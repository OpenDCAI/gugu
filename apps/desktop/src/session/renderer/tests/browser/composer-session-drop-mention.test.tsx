/**
 * 把侧栏的一条会话行拖进 composer,落下变成一枚 @ 提及(behavior session-page「把会话拖成 @」)。
 *
 * 判据在真 DOM 上:构造真的 `DragEvent` + `DataTransfer` 派发进编辑器,读 composer 实际调出去的
 * 回调与编辑器里最终的文本。⚠️ 三条反向对照是这组测试的重点:
 *   · 落在编辑器**里面**与落在 composer 的空白处,宿主都必须**只**被叫到一次 —— 编辑器(ProseMirror)
 *     和 composer 外壳各有一个 drop 处理,两边都收就会插进两枚 pill;
 *   · 载荷里若同时带 `text/plain`,那段文字**不许**被 ProseMirror 插进正文 —— 否则一次拖拽得到
 *     一枚 pill 外加一段裸文字;
 *   · 没带会话标记的普通文本拖放**不许**被宿主认领 —— 否则「往输入框里拖一段字」这条路会被吞掉。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatComposer, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { SCREEN_CONTENT_DRAG_TYPE } from '@renderer/lib/drag-screen-content'
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

type Mounted = { claimed: DataTransfer[]; editor: { current: PromptEditorRef | null } }

function mount(): Mounted {
  host = document.createElement('div')
  host.className = 'gugu-skin'
  document.body.appendChild(host)
  const claimed: DataTransfer[] = []
  const editor: { current: PromptEditorRef | null } = { current: null }
  root = createRoot(host)
  root.render(
    <SessionLocalizationProvider>
      <ChatComposer
        editorApiRef={editor}
        dataDropTypes={[SCREEN_CONTENT_DRAG_TYPE]}
        onDataDropped={(dataTransfer) => claimed.push(dataTransfer)}
        onAttachmentsChange={() => {}}
        onSubmit={() => {}}
      />
    </SessionLocalizationProvider>,
  )
  return { claimed, editor }
}

function editable(): HTMLElement {
  return host!.querySelector<HTMLElement>('[contenteditable="true"]')!
}

/** 首帧是排程出去的:ProseMirror 视图进了 DOM(contenteditable)且 editorApiRef 已挂上才算就绪。 */
function ready(editor: Mounted['editor']): boolean {
  return host?.querySelector('[contenteditable="true"]') != null && editor.current != null
}

function shell(): HTMLElement {
  return host!.querySelector<HTMLElement>('[data-slot="composer-bar"]')!
}

/** 坐标必须真的落在目标里:ProseMirror 的 drop 先 `posAtCoords`,落在外面它整条就不走了。 */
function drop(target: HTMLElement, entries: Record<string, string>) {
  const dataTransfer = new DataTransfer()
  for (const [type, value] of Object.entries(entries)) dataTransfer.setData(type, value)
  const rect = target.getBoundingClientRect()
  target.dispatchEvent(
    new DragEvent('drop', {
      dataTransfer,
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  )
}

const sessionPayload = JSON.stringify({ kind: 'session', projectId: 'p', sessionId: 'conv-1', title: '头像抽卡' })

describe('把会话拖进 composer', () => {
  it('落在编辑器里 —— 宿主收到一次,正文不动', async () => {
    const { claimed, editor } = mount()
    await until('编辑器就绪', () => ready(editor))

    drop(editable(), { [SCREEN_CONTENT_DRAG_TYPE]: sessionPayload })
    await until('宿主收到这次 drop', () => claimed.length > 0)

    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.getData(SCREEN_CONTENT_DRAG_TYPE)).toBe(sessionPayload)
    // 两个 drop 处理都是同步的:编辑器那一手(packages/session-ui/src/react/components/prompt-editor/
    // prompt-editor.tsx:377-383,返回 true ⇒ ProseMirror 当场止步不插入)与外壳那一手
    // (chat-composer/index.tsx:524-536)。宿主已收到 ⇒ 这次 drop 已处理完,正文此刻即终局。
    expect(editor.current?.getText()).toBe('')
  })

  it('落在 composer 的空白处 —— 同样收到一次', async () => {
    const { claimed, editor } = mount()
    await until('编辑器就绪', () => ready(editor))

    drop(shell(), { [SCREEN_CONTENT_DRAG_TYPE]: sessionPayload })
    await until('宿主收到这次 drop', () => claimed.length > 0)
    // 外壳的 handleDrop 同步(chat-composer/index.tsx:524-536):此刻的次数即终局。

    expect(claimed).toHaveLength(1)
  })

  it('载荷里带 text/plain 时,那段文字不许被插进正文', async () => {
    const { claimed, editor } = mount()
    await until('编辑器就绪', () => ready(editor))

    drop(editable(), { [SCREEN_CONTENT_DRAG_TYPE]: sessionPayload, 'text/plain': '头像抽卡' })
    await until('宿主收到这次 drop', () => claimed.length > 0)

    expect(claimed).toHaveLength(1)
    // 同第一条:两手 drop 处理都同步,宿主已收到 ⇒ 正文此刻即终局。
    expect(editor.current?.getText()).toBe('')
  })

  it('没有会话标记的普通文本拖放,宿主不认领', async () => {
    const { claimed, editor } = mount()
    await until('编辑器就绪', () => ready(editor))

    drop(editable(), { 'text/plain': '一段普通文字' })
    // 两个 drop 处理都同步(prompt-editor.tsx:377-383 / chat-composer/index.tsx:524-559),
    // 没有会话标记时两者都不调 onDataDropped;drop() 返回即终局。

    expect(claimed).toHaveLength(0)
  })
})


describe('a resource link uses ordinary editor text', () => {
  it('drops the same complete URL that a text paste inserts, without a mention or an attachment', async () => {
    const { claimed, editor } = mount()
    await until('editor ready', () => ready(editor))
    const link = 'gugu-file://123e4567-e89b-42d3-a456-426614174000'
    drop(editable(), { 'text/plain': link, 'text/uri-list': link })
    const dropped = editor.current?.getText()
    expect(dropped).toBe(link)
    editor.current?.clear()
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', link)
    editable().dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    expect(editor.current?.getText()).toBe(dropped)
    expect(editable().querySelector('[data-mention-id]')).toBeNull()
    expect(claimed).toHaveLength(0)
  })
})

/**
 * 输入框里的附件 chip 点开预览（#5269，owner 2026-09-09：「点击怎么没法展开预览啊，文件也是」）。
 *
 * 判据在真 DOM 上：真的派发 click，读 composer 实际调出去的回调。这一组的三条各防一个具体的坏法：
 *   · **点名字那一半**必须也能开 —— 从前只有 32px 图标格是按钮，用户点在名字上什么也不会发生，
 *     而名字是这枚 chip 上最大的一块。所以这里故意点 `[data-slot=composer-attachment]` 里的
 *     名字元素，❌ 不点根节点（点根节点的话，「只有图标格可点」的旧实现也可能因为冒泡而绿）。
 *   · **点 × 不许顺手把预览也开出来** —— 整块可点之后，移除按钮的 click 会冒泡到触发器上。
 *     去掉 `stopPropagation` 这条就红。
 *   · **手上没有可看内容的 chip 必须点不开** —— 否则用户点开的是一个空对话框，那比不可点更像坏了。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatComposer, type ComposerAttachment } from '@gugu/session-ui/react/components'
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

type Seen = { viewed: ComposerAttachment[]; changed: ComposerAttachment[][] }

function mount(attachments: ComposerAttachment[]): Seen {
  host = document.createElement('div')
  host.className = 'gugu-skin'
  document.body.appendChild(host)
  const seen: Seen = { viewed: [], changed: [] }
  root = createRoot(host)
  root.render(
    <SessionLocalizationProvider>
      <ChatComposer
        attachments={attachments}
        onAttachmentsChange={(next) => seen.changed.push(next)}
        onViewAttachment={(att) => seen.viewed.push(att)}
        onSubmit={() => {}}
      />
    </SessionLocalizationProvider>,
  )
  return seen
}

const chip = () => host!.querySelector<HTMLElement>('[data-slot="composer-attachment"]')!
/** createRoot 的首帧是排程出去的:要点的 chip 进了 DOM 才算挂好。 */
const mounted = () => host?.querySelector('[data-slot="composer-attachment"]') != null
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

const textAttachment: ComposerAttachment = {
  id: 'a1',
  name: 'pasted-text.txt',
  kind: 'file',
  mimeType: 'text/plain',
  meta: '21.6 KB',
  previewText: '粘进来的那一大段',
}

describe('composer attachment preview (#5269)', () => {
  it('点文件 chip 的名字那一半就能开预览', async () => {
    const seen = mount([textAttachment])
    await until('chip 挂载', () => mounted())

    const name = [...chip().querySelectorAll('span')].find((el) => el.textContent === 'pasted-text.txt')
    expect(name, 'chip 上应该有名字这一格').toBeTruthy()
    click(name!)
    await until('预览回调收到一次', () => seen.viewed.length > 0)

    expect(seen.viewed.map((att) => att.id)).toEqual(['a1'])
    expect(seen.viewed[0]!.previewText).toBe('粘进来的那一大段')
    expect(chip().getAttribute('role')).toBe('button')
  })

  it('图片 chip 同样整块可点', async () => {
    const seen = mount([
      { id: 'i1', name: 'image.png', kind: 'image', previewUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    ])
    await until('chip 挂载', () => mounted())

    const name = [...chip().querySelectorAll('span')].find((el) => el.textContent === 'image.png')
    click(name!)
    await until('预览回调收到一次', () => seen.viewed.length > 0)

    expect(seen.viewed.map((att) => att.id)).toEqual(['i1'])
    expect(chip().getAttribute('data-viewable')).toBe('image')
  })

  it('点 × 只是移除，❌ 不许把预览一起开出来', async () => {
    const seen = mount([textAttachment])
    await until('chip 挂载', () => mounted())

    const remove = chip().querySelector('button')
    expect(remove, 'done 态且宿主在听移除时应该有 ×').toBeTruthy()
    click(remove!)
    await until('移除回调收到一次', () => seen.changed.length > 0)

    expect(seen.changed).toHaveLength(1)
    expect(seen.changed[0]).toEqual([])
    // × 的 onClick 同步地 stopPropagation 再移除(packages/session-ui/src/react/components/chat-composer/
    // composer-attachment-chip.tsx:101-104):移除回调已到 ⇒ 这一下 click 已处理完,预览此刻没响即终局。
    expect(seen.viewed, '删一件附件不该顺手弹一个预览').toEqual([])
  })

  it('反向对照：手上没有可看内容的 chip 点不开，也不是按钮', async () => {
    const seen = mount([{ id: 'z1', name: 'bundle.zip', kind: 'file', meta: '3.1 MB' }])
    await until('chip 挂载', () => mounted())

    const target = chip()
    expect(target.getAttribute('role')).toBeNull()
    expect(target.getAttribute('data-viewable')).toBeNull()
    click(target)
    // 不可看的 chip 根本不挂 onClick(composer-attachment-chip.tsx:71,previewKind 为 null ——
    // 上面 role/data-viewable 为空正是它):这一下 click 没有任何处理者,dispatch 返回即终局。
    expect(seen.viewed).toEqual([])
  })
})

/**
 * 侧栏会话行必须真的拖得动 —— behavior session-page「把会话拖成 @」的前提。
 *
 * 这一条守的是一个隐蔽的坑:行(和铺满行的那枚标题按钮)原本用 `onMouseDown preventDefault` 挡
 * 「点一行不抢焦点」,而拦掉 mousedown 的默认动作会**连带**拦掉浏览器发起原生拖拽 —— 连
 * `dragstart` 都不发。所以判据必须是一次真的拖拽(playwright 真指针),❌ 不能只断言某个属性挂上了。
 * 反向对照就在同一个文件里:没打开 `allowNativeDrag` 的那一行,同样的拖拽什么都不发生。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { SidebarMenuAction, SidebarMenuRow } from '@renderer/features/sidebar/sidebar-primitives'
import {
  clearDraggedScreenContent,
  getDraggedScreenContent,
  setDraggedScreenContent,
  SCREEN_CONTENT_DRAG_TYPE,
} from '@renderer/lib/drag-screen-content'
import '@/styles/tokens.css'
import '@renderer/index.css'

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  root?.unmount()
  root = null
  host?.remove()
  host = null
  clearDraggedScreenContent()
})

/** 拦下 setDragImage,看浏览器真正拿去当拖拽图的是哪块 DOM。 */
function spyDragImage() {
  const seen: { hoverActions: number; text: string }[] = []
  const original = DataTransfer.prototype.setDragImage
  DataTransfer.prototype.setDragImage = function (el: Element, x: number, y: number) {
    seen.push({
      hoverActions: el.querySelectorAll('[data-row-hover-actions]').length,
      text: (el.textContent || '').trim(),
    })
    return original.call(this, el, x, y)
  }
  return { seen, restore: () => { DataTransfer.prototype.setDragImage = original } }
}

function mount() {
  host = document.createElement('div')
  host.className = 'gugu-skin'
  host.style.width = '320px'
  document.body.appendChild(host)
  const dropped: (string | null)[] = []
  root = createRoot(host)
  root.render(
    <div>
      {(['draggable-row', 'guarded-row'] as const).map((id) => (
        <SidebarMenuRow
          key={id}
          data-testid={id}
          className="flex h-8 items-center"
          draggable
          onDragStart={(e) =>
            setDraggedScreenContent(e.dataTransfer, { kind: 'session', projectId: 'p', sessionId: id, title: '头像抽卡' }, e.currentTarget)
          }
          onDragEnd={clearDraggedScreenContent}
        >
          <SidebarMenuAction allowNativeDrag={id === 'draggable-row'}>{id}</SidebarMenuAction>
          {/* 行尾那层「置顶 / 归档 / 时间」—— 只在 hover 时显形,所以它正好是拖拽图里不该有的东西 */}
          <span data-row-hover-actions>归档</span>
        </SidebarMenuRow>
      ))}
      <div
        data-testid="drop-zone"
        style={{ height: '80px', background: '#eee' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const content = getDraggedScreenContent(e.dataTransfer)
          dropped.push(content?.kind === 'session' ? content.sessionId : null)
        }}
      >
        drop zone
      </div>
    </div>,
  )
  return dropped
}

test('标题按钮放行 mousedown 时,整行拖得进落点', async () => {
  const dropped = mount()
  await until('draggable-row is in the document', () => page.getByTestId('draggable-row').query() != null)

  await userEvent.dragAndDrop(
    page.getByTestId('draggable-row'),
    page.getByTestId('drop-zone'),
  )

  expect(dropped).toEqual(['draggable-row'])
})

test('反向对照:标题按钮仍吞掉 mousedown 的那一行,拖拽根本发不出来', async () => {
  const dropped = mount()
  await until('guarded-row is in the document', () => page.getByTestId('guarded-row').query() != null)

  await userEvent.dragAndDrop(
    page.getByTestId('guarded-row'),
    page.getByTestId('drop-zone'),
  )

  expect(dropped).toEqual([])
})

test('拖拽载荷只带会话标记,不带 text/plain', async () => {
  mount()
  const transfer = new DataTransfer()
  setDraggedScreenContent(transfer, { kind: 'session', projectId: 'p', sessionId: 'conv-1', title: '头像抽卡' })
  expect(transfer.types).toEqual([SCREEN_CONTENT_DRAG_TYPE])
})

test('拖起来的那张图里没有行尾那层 hover 动作(置顶 / 归档 / 时间)', async () => {
  mount()
  const spy = spyDragImage()
  try {
    await until('draggable-row is in the document', () => page.getByTestId('draggable-row').query() != null)
    await userEvent.dragAndDrop(page.getByTestId('draggable-row'), page.getByTestId('drop-zone'))

    // 浏览器确实用了我们给的那张图,而不是默认地拍活着的那一行
    expect(spy.seen).toHaveLength(1)
    // 那张图里一个 hover 动作节点都没有;行本身的内容还在
    expect(spy.seen[0]!.hoverActions).toBe(0)
    expect(spy.seen[0]!.text).toContain('draggable-row')
    expect(spy.seen[0]!.text).not.toContain('归档')
  } finally {
    spy.restore()
  }
})

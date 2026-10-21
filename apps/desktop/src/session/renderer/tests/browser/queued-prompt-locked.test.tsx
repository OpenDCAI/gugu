/**
 * 会话还没连上时排进去的那一句,排队条里只显示、不给操作(behavior session-page「打开速度」)。
 *
 * 运行时排队只回「排上了没有」、不回它在队列里的编号 ⇒ 这时改、删、挪、立即发送都做不到。
 * ❌ 摆着按钮、点了才报「没连上」;会话一连上,这一句换成运行时那份能操作的(那一份不带 locked)。
 * 阳性对照:同一条排队条里不锁的那一句,按钮照常都在 —— 否则「锁着的没按钮」读不出东西。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { QueuedPromptsBand } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import '@/styles/tokens.css'
import '@renderer/index.css'

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  root?.unmount()
  root = null
  host?.remove()
  host = null
})

test('a prompt queued before the session connects is shown without actions', async () => {
  const calls: string[] = []
  host = document.createElement('div')
  host.className = 'gugu-skin'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <SessionLocalizationProvider>
      <QueuedPromptsBand
        prompts={[
          { id: 'live', text: 'already in the runtime queue', origin: 'manual' },
          { id: 'startup', text: 'queued while connecting', origin: 'manual', locked: true },
          { id: 'live2', text: 'another runtime entry', origin: 'manual' },
        ]}
        onEdit={(id) => calls.push(`edit:${id}`)}
        onDelete={(id) => calls.push(`delete:${id}`)}
        onReorder={() => calls.push('reorder')}
        onSendNow={(id) => calls.push(`send:${id}`)}
      />
    </SessionLocalizationProvider>,
  )
  await until('both rows render', () => host!.textContent?.includes('queued while connecting') ?? false)

  // 一行 = 从这句文字往上、再上一层就会把另一行也包进来之前的那一层
  const rowOf = (text: string, other: string) => {
    let el = [...host!.querySelectorAll<HTMLElement>('*')].find(
      (node) => node.children.length === 0 && node.textContent?.trim() === text,
    )!
    while (el.parentElement && !el.parentElement.textContent?.includes(other)) el = el.parentElement
    return el
  }
  const live = rowOf('already in the runtime queue', 'queued while connecting')
  const locked = rowOf('queued while connecting', 'already in the runtime queue')

  // 阳控:不锁的那一句,拖动、编辑、立即发送、删除都在
  expect(live.querySelectorAll('button').length).toBeGreaterThanOrEqual(4)
  expect(live.querySelector('[draggable="true"]')).not.toBeNull()

  // 锁着的那一句:一个按钮都没有、拖不动,文字也点不进编辑
  expect(locked.querySelectorAll('button')).toHaveLength(0)
  expect(locked.querySelector('[draggable="true"]')).toBeNull()
  locked.querySelector<HTMLElement>('[data-locked="true"]')!.click()
  expect(host!.querySelector('textarea')).toBeNull()
  expect(calls).toEqual([])
})

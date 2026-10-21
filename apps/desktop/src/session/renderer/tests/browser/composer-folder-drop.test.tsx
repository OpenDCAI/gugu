/**
 * 拖一个**文件夹**进 composer:它不进附件通道(没有可上传的字节,进去只能静默消失),
 * 由宿主收走放进正文(behavior session-page「把文件夹拖进输入框」)。
 *
 * 判据在真 DOM 上:派发真的 `DragEvent` + `DataTransfer`,读 composer 实际调出去的回调。
 * 合成 DataTransfer 里 `webkitGetAsEntry` 对程序添加的文件返回 null,所以这里在实例上
 * 盖掉 `items`/`files`,让每一项带上自己的 entry —— 真实的 OS 文件夹拖放在 Chromium 里
 * 正是经 `webkitGetAsEntry().isDirectory` 才认得出目录。
 *
 * ⚠️ 反向对照是这组测试的重点:
 *   · 混合拖放(文件夹 + 普通文件)→ 文件必须照旧走 `onFilesDropped`,❌ 不许被文件夹带走;
 *   · 宿主没接 `onDirectoriesDropped` → 文文件夹回落进 `onFilesDropped`(旧行为),❌ 不许凭空消失。
 * 少了这两条,「把目录整个丢掉」或「把文件也一起改道」的实现同样能过第一条。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatComposer } from '@gugu/session-ui/react/components'
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

type Seen = { directories: File[][]; files: File[][] }

function mount(withDirectoryChannel: boolean): Seen {
  host = document.createElement('div')
  host.className = 'gugu-skin'
  document.body.appendChild(host)
  const seen: Seen = { directories: [], files: [] }
  root = createRoot(host)
  root.render(
    <SessionLocalizationProvider>
      <ChatComposer
        onFilesDropped={(f) => seen.files.push(f)}
        {...(withDirectoryChannel
          ? { onDirectoriesDropped: (f: File[]) => seen.directories.push(f) }
          : {})}
        onAttachmentsChange={() => {}}
        onSubmit={() => {}}
      />
    </SessionLocalizationProvider>,
  )
  return seen
}

function shell(): HTMLElement {
  return host!.querySelector<HTMLElement>('[data-slot="composer-bar"]')!
}

/** createRoot 的首帧是排程出去的:drop 的目标(composer-bar)进了 DOM 才算挂好。 */
const mounted = () => host?.querySelector('[data-slot="composer-bar"]') != null

/** 每一项 = 一个文件/文件夹:entry 的 isDirectory 决定它走哪条道。 */
function drop(entries: Array<{ file: File; isDirectory: boolean }>) {
  const dataTransfer = new DataTransfer()
  Object.defineProperty(dataTransfer, 'items', {
    value: entries.map(({ file, isDirectory }) => ({
      kind: 'file',
      getAsFile: () => file,
      webkitGetAsEntry: () => ({ isDirectory }),
    })),
  })
  Object.defineProperty(dataTransfer, 'files', { value: entries.map((e) => e.file) })
  const target = shell()
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

const folder = () => new File([''], '截图存档', { type: '' })
const plainFile = () => new File(['hello'], 'notes.txt', { type: 'text/plain' })

describe('把文件夹拖进 composer', () => {
  it('只有文件夹 → 宿主的文件夹通道收走,文件通道不响', async () => {
    const seen = mount(true)
    await until('composer-bar 挂载', () => mounted())

    drop([{ file: folder(), isDirectory: true }])
    await until('文件夹通道收到一次', () => seen.directories.length > 0)

    expect(seen.directories).toHaveLength(1)
    expect(seen.directories[0]![0]!.name).toBe('截图存档')
    // handleDrop 是同步的(packages/session-ui/src/react/components/chat-composer/index.tsx:524-559):
    // drop() 返回时两条通道该响的都已响完,另一条的沉默此刻即终局。
    expect(seen.files).toHaveLength(0)
  })

  it('混合拖放 → 文件夹走文件夹通道,普通文件照旧走附件通道', async () => {
    const seen = mount(true)
    await until('composer-bar 挂载', () => mounted())

    drop([
      { file: folder(), isDirectory: true },
      { file: plainFile(), isDirectory: false },
    ])
    await until('两条通道各收到一次', () => seen.directories.length > 0 && seen.files.length > 0)

    expect(seen.directories).toHaveLength(1)
    expect(seen.directories[0]).toHaveLength(1)
    expect(seen.files).toHaveLength(1)
    expect(seen.files[0]![0]!.name).toBe('notes.txt')
  })

  it('宿主没接文件夹通道 → 文件夹回落进文件通道(旧行为),❌ 不静默丢', async () => {
    const seen = mount(false)
    await until('composer-bar 挂载', () => mounted())

    drop([
      { file: folder(), isDirectory: true },
      { file: plainFile(), isDirectory: false },
    ])
    await until('文件通道收到一次', () => seen.files.length > 0)

    expect(seen.files).toHaveLength(1)
    const names = seen.files[0]!.map((f) => f.name)
    expect(names).toContain('截图存档')
    expect(names).toContain('notes.txt')
  })
})

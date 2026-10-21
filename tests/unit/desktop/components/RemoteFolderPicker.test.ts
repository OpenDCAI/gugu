// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { clickElement } from '../../../support/testHarness'
const listMock = vi.fn()
const mkdirMock = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/deviceFs', () => ({
  deviceFsListDirectory: (...args: unknown[]) => listMock(...args),
  deviceFsMakeDirectory: (...args: unknown[]) => mkdirMock(...args),
}))
import { RemoteFolderPicker } from '../../../../apps/desktop/src/components/RemoteFolderPicker'
let container: HTMLDivElement
let root: Root
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  listMock.mockReset()
  mkdirMock.mockReset()
})
afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})
describe('RemoteFolderPicker', () => {
  it('does not allow selecting the unresolved initial path while loading', async () => {
    const onSelect = vi.fn()
    listMock.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-loading', initialPath: '~', onSelect }))
    })
    await flush()
    expect(container.textContent).toContain('正在连接远程主机')
    expect(container.textContent).toContain('加载中...')
    const useButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '使用此目录') as HTMLButtonElement | undefined
    expect(useButton?.disabled).toBe(true)
    await clickElement(useButton!)
    expect(onSelect).not.toHaveBeenCalled()
  })
  it('renders entries returned by deviceFsListDirectory, directories first', async () => {
    listMock.mockResolvedValueOnce({
      result: {
        path: '/Users/me',
        entries: [
          { name: 'README.md', kind: 'file' },
          { name: 'projects', kind: 'dir' },
          { name: 'docs', kind: 'dir' },
        ],
      },
    })
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-A', onSelect: () => {} }))
    })
    await flush()
    expect(listMock).toHaveBeenCalledWith(
      'dev-A',
      { path: '~', show_hidden: false },
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000, retryOnTimeout: false }),
    )
    const labels = Array.from(container.querySelectorAll('li button')).map((el) => {
      // The label is in the second <span> inside the entry button.
      const spans = el.querySelectorAll(':scope > span')
      return (spans[1]?.textContent ?? '').trim()
    })
    expect(labels).toEqual(['docs', 'projects', 'README.md'])
    expect(container.textContent).toContain('/Users/me')
    expect(container.textContent).toContain('3 项')
  })
  it('navigates into a folder on click and re-fetches', async () => {
    listMock.mockResolvedValueOnce({
      result: {
        path: '/home/me',
        entries: [{ name: 'src', kind: 'dir' }],
      },
    })
    listMock.mockResolvedValueOnce({
      result: {
        path: '/home/me/src',
        entries: [{ name: 'index.ts', kind: 'file' }],
      },
    })
    await act(async () => {
      root.render(
        createElement(RemoteFolderPicker, {
          deviceId: 'dev-B',
          initialPath: '/home/me',
          onSelect: () => {},
        }),
      )
    })
    await flush()
    const buttons = Array.from(container.querySelectorAll('li button')) as HTMLButtonElement[]
    expect(buttons).toHaveLength(1)
    await clickElement(buttons[0])
    await flush()
    expect(listMock).toHaveBeenCalledTimes(2)
    expect(listMock.mock.calls[1][0]).toBe('dev-B')
    expect(listMock.mock.calls[1][1]).toEqual({ path: '/home/me/src', show_hidden: false })
    const labels = Array.from(container.querySelectorAll('li button')).map((el) => {
      const spans = el.querySelectorAll(':scope > span')
      return (spans[1]?.textContent ?? '').trim()
    })
    expect(labels).toEqual(['index.ts'])
  })
  it('连不上那台机器时说清楚、给重试,且不许选一个没核实过的路径', async () => {
    const timeout = Object.assign(new Error('设备 RPC timed out after 5000ms (type=fs.list-directory)'), { name: 'DeviceRpcTimeoutError' })
    listMock.mockRejectedValueOnce(timeout)
    const onSelect = vi.fn()
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-C', initialPath: '/Users/me', onSelect }))
    })
    await flush()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent ?? '').toContain('无响应')
    expect(alert?.textContent ?? '').not.toContain('timed out')
    expect(alert?.querySelector('button')?.textContent ?? '').toContain('重试')
    const useButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '使用此目录') as HTMLButtonElement | undefined
    expect(useButton?.disabled).toBe(true)
  })
  it('地址栏可以直接输入路径:点路径条空白处 → 输入 → 回车就去那个目录(#6264 反馈「浏览时应该能输入路径」)', async () => {
    listMock.mockResolvedValue({ result: { path: '/home/bob', entries: [] } })
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-P', onSelect: () => {} }))
    })
    await flush()
    await clickElement(container.querySelector('[data-testid="remote-folder-path-blank"]') as HTMLElement)
    const input = container.querySelector('[data-testid="remote-folder-path-input"]') as HTMLInputElement
    expect(input.value).toBe('/home/bob')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '/srv/data/repo')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()
    expect(listMock).toHaveBeenLastCalledWith('dev-P', { path: '/srv/data/repo', show_hidden: false }, expect.anything())
    expect(container.querySelector('[data-testid="remote-folder-path-input"]')).toBeNull()
  })

  it('地址栏右上只有刷新,❌ 铅笔(点路径就能改,铅笔是同一件事的第二个入口);空白处是个真按钮,键盘够得着,⌘L 也能进', async () => {
    listMock.mockResolvedValue({ result: { path: '/home/bob', entries: [] } })
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-K', onSelect: () => {} }))
    })
    await flush()
    expect(container.querySelector('[data-testid="remote-folder-path-edit"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('button[aria-label="刷新"]'))).toHaveLength(1)
    const blank = container.querySelector('[data-testid="remote-folder-path-blank"]') as HTMLElement
    // 原生 <button>:Tab 停得下、回车 / 空格就是点击;有读得出来的名字。
    expect(blank.tagName).toBe('BUTTON')
    expect(blank.textContent).toBe('输入路径')
    expect(blank.hasAttribute('aria-hidden')).toBe(false)
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }))
    })
    expect((container.querySelector('[data-testid="remote-folder-path-input"]') as HTMLInputElement | null)?.value).toBe('/home/bob')
  })

  it('打开时焦点就在选择框里:不用先点一下,直接敲 / 就能输路径', async () => {
    listMock.mockResolvedValue({ result: { path: '/home/bob', entries: [] } })
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-F', onSelect: () => {} }))
    })
    await flush()
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    expect(document.activeElement).toBe(dialog)
  })

  it('在列表上直接敲 / 就开始输入路径,Esc 放弃、不跳走', async () => {
    listMock.mockResolvedValue({ result: { path: '/home/bob', entries: [] } })
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-Q', onSelect: () => {} }))
    })
    await flush()
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
    })
    const input = container.querySelector('[data-testid="remote-folder-path-input"]') as HTMLInputElement
    expect(input.value).toBe('/')
    const calls = listMock.mock.calls.length
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    expect(container.querySelector('[data-testid="remote-folder-path-input"]')).toBeNull()
    expect(listMock.mock.calls.length).toBe(calls)
  })

  it('路径不存在时留在原地、点名说哪个路径不存在,手上的目录照样能选', async () => {
    listMock.mockResolvedValueOnce({ result: { path: '/home/bob', entries: [{ name: 'code', kind: 'dir' }] } })
    listMock.mockResolvedValueOnce({ error: { code: 'not_found', message: 'not found: /nope' } })
    const onSelect = vi.fn()
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-N', initialPath: '/home/bob', onSelect }))
    })
    await flush()
    await typePath('/nope')
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent ?? '').toContain('那台机器上没有 /nope')
    // 不自己跳走:列表还是 /home/bob 那份,没有第三次读取。
    expect(listMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('code')
    await clickElement(buttonByText('使用此目录')!)
    expect(onSelect).toHaveBeenCalledWith('/home/bob')
  })

  it('筛选:长目录里按名字过滤,没有匹配时说清楚', async () => {
    listMock.mockResolvedValueOnce({ result: { path: '/srv', entries: [{ name: 'alpha', kind: 'dir' }, { name: 'beta', kind: 'dir' }] } })
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-F', initialPath: '/srv', onSelect: () => {} }))
    })
    await flush()
    const filter = container.querySelector('[data-testid="remote-folder-filter"]') as HTMLInputElement
    await setValue(filter, 'alp')
    expect(entryLabels()).toEqual(['alpha'])
    await setValue(filter, 'zzz')
    expect(entryLabels()).toEqual([])
    expect(container.textContent).toContain('这里没有名字里带「zzz」的项')
  })

  it('地址栏补全:Tab 补成那台机器上真实存在的子文件夹', async () => {
    listMock.mockResolvedValueOnce({ result: { path: '/home/bob', entries: [{ name: 'projects', kind: 'dir' }, { name: 'pics', kind: 'dir' }, { name: 'p.txt', kind: 'file' }] } })
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-T', initialPath: '/home/bob', onSelect: () => {} }))
    })
    await flush()
    await clickElement(container.querySelector('[data-testid="remote-folder-path-blank"]') as HTMLElement)
    const input = container.querySelector('[data-testid="remote-folder-path-input"]') as HTMLInputElement
    await setValue(input, '/home/bob/pr')
    await flush()
    const options = Array.from(container.querySelectorAll('[data-testid="remote-folder-path-suggestions"] li')).map((li) => li.textContent)
    expect(options).toEqual(['projects'])
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect((container.querySelector('[data-testid="remote-folder-path-input"]') as HTMLInputElement).value).toBe('/home/bob/projects/')
  })

  it('选根目录或主目录本身当项目:先问一句,确认后才选', async () => {
    listMock.mockResolvedValueOnce({ result: { path: '/home/bob', home: '/home/bob', entries: [] } })
    const onSelect = vi.fn()
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-H', onSelect }))
    })
    await flush()
    await clickElement(buttonByText('使用此目录')!)
    expect(onSelect).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="remote-folder-broad-confirm"]')?.textContent ?? '').toContain('主目录')
    await clickElement(container.querySelector('[data-testid="remote-folder-broad-use"]') as HTMLElement)
    expect(onSelect).toHaveBeenCalledWith('/home/bob')
  })

  it('新建文件夹:在那台机器上建好后直接进去;老版本机器不认时如实说', async () => {
    listMock.mockResolvedValueOnce({ result: { path: '/srv', entries: [] } })
    listMock.mockResolvedValueOnce({ result: { path: '/srv/app', entries: [] } })
    mkdirMock.mockResolvedValueOnce({ error: { code: 'unknown_method', message: 'unknown device RPC type' } })
    mkdirMock.mockResolvedValueOnce({ result: { path: '/srv/app' } })
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-M', initialPath: '/srv', onSelect: () => {} }))
    })
    await flush()
    await clickElement(container.querySelector('[data-testid="remote-folder-new"]') as HTMLElement)
    const name = container.querySelector('[data-testid="remote-folder-new-name"]') as HTMLInputElement
    await setValue(name, 'app')
    await pressEnter(name)
    await flush()
    expect(container.textContent).toContain('版本太旧')
    expect(container.textContent).not.toContain('unknown device RPC type')
    await pressEnter(container.querySelector('[data-testid="remote-folder-new-name"]') as HTMLInputElement)
    await flush()
    expect(mkdirMock).toHaveBeenLastCalledWith('dev-M', '/srv/app', expect.anything())
    expect(listMock).toHaveBeenLastCalledWith('dev-M', { path: '/srv/app', show_hidden: false }, expect.anything())
  })

  it('主目录捷径:一键回到那台机器的主目录', async () => {
    listMock.mockResolvedValue({ result: { path: '/srv', home: '/home/bob', entries: [] } })
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-K', initialPath: '/srv', onSelect: () => {} }))
    })
    await flush()
    await clickElement(container.querySelector('[data-testid="remote-folder-home"]') as HTMLElement)
    expect(listMock).toHaveBeenLastCalledWith('dev-K', { path: '~', show_hidden: false }, expect.anything())
  })
})

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent === text) as HTMLButtonElement | undefined
}

function entryLabels(): string[] {
  return Array.from(container.querySelectorAll('li button')).map((el) => (el.querySelectorAll(':scope > span')[1]?.textContent ?? '').trim())
}

async function setValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressEnter(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

async function typePath(path: string) {
  await clickElement(container.querySelector('[data-testid="remote-folder-path-blank"]') as HTMLElement)
  const input = container.querySelector('[data-testid="remote-folder-path-input"]') as HTMLInputElement
  await setValue(input, path)
  await pressEnter(input)
}

// @vitest-environment jsdom
// #709 示例项目那段对话:一次真跑固化下来的内容,打开它不读网络;文件就是跑的那一次服务端记下的那一版。
import { createHash } from 'node:crypto'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SampleProjectTranscript } from '../../../../apps/desktop/src/session/renderer/features/sample-project/sample-project-transcript'
import { zhCNSampleProject } from '../../../../apps/desktop/src/session/renderer/features/sample-project/content/zh-CN'
import { enUSSampleProject } from '../../../../apps/desktop/src/session/renderer/features/sample-project/content/en-US'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
let fetchSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  harness = createReactHarness()
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})
afterEach(() => {
  harness.cleanup()
  fetchSpy.mockRestore()
})

const owner = { id: 'owner-1', name: 'Ana', avatarUrl: null }

async function render(content = zhCNSampleProject) {
  const onOpenFile = vi.fn()
  const onOpenTask = vi.fn()
  await renderWithAppProviders(harness, createNode(SampleProjectTranscript, { content, owner, onOpenFile, onOpenTask }))
  await act(async () => { await Promise.resolve() })
  return { onOpenFile, onOpenTask, root: harness.container }
}

describe('sample project conversation (#709)', () => {
  for (const [locale, content] of [['zh-CN', zhCNSampleProject], ['en-US', enUSSampleProject]] as const) {
    it(`${locale}: every bundled file is the version the run recorded`, () => {
      expect(content.files.length).toBeGreaterThan(0)
      for (const file of content.files) expect(createHash('sha256').update(file.text, 'utf8').digest('hex')).toBe(file.sha256)
    })

    it(`${locale}: the agent's mention of the person is kept as a mark, not as the run account's name`, () => {
      const texts = content.messages.flatMap((message) => (message.kind === 'text' ? [message] : []))
      expect(texts.some((message) => message.mentionsOwner)).toBe(true)
      for (const message of texts) expect(message.text).not.toMatch(/^@/)
    })
  }

  it('shows the frozen task card, the files and the reply, and reads nothing from the network', async () => {
    const { root } = await render()
    const card = root.querySelector('[data-tour="sample-task-card"]')
    const task = zhCNSampleProject.messages.find((message) => message.kind === 'task')!
    expect(card?.textContent).toContain(task.text.slice(0, 20))
    for (const file of zhCNSampleProject.files) expect(root.querySelector(`[aria-label="${file.name}"]`)).not.toBeNull()
    expect(root.textContent).toContain('@Ana')
    expect(root.textContent).toContain(zhCNSampleProject.agent.name)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('opens the task when its card is clicked, and a file when its card is clicked', async () => {
    const { root, onOpenFile, onOpenTask } = await render()
    await clickElement(root.querySelector<HTMLElement>('[data-tour="sample-task-card"]')!)
    expect(onOpenTask).toHaveBeenCalledTimes(1)
    const file = zhCNSampleProject.files[0]!
    await clickElement(root.querySelector<HTMLElement>(`[aria-label="${file.name}"]`)!)
    expect(onOpenFile).toHaveBeenCalledWith(file.id)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

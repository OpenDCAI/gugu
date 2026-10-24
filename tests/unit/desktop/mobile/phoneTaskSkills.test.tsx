// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../../support/testHarness'

const rpc = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), available: true }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/phoneTaskSkills', async (original) => ({ ...await original<typeof import('../../../../apps/desktop/src/mobile/local-agent/phoneTaskSkills')>(), readPhoneTaskSkills: rpc.read, savePhoneTaskSkills: rpc.save }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/nativeAgent', () => ({ phoneAgentAvailable: () => rpc.available }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'skill-owner' } }) }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings', () => ({ thisPhoneDeviceId: () => 'this-phone' }))
vi.mock('../../../../apps/desktop/src/components/ui/Sheet', () => ({ Sheet: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => createElement('section', { role: 'dialog' }, createElement('button', { 'data-testid': 'sheet-dismiss', onClick: onClose }, 'dismiss'), children) }))

import { PhoneSkillsManager, PhoneTaskSkills } from '../../../../apps/desktop/src/mobile/local-agent/PhoneTaskSkillsButton'
import { importPhoneTaskSkill, validatePhoneTaskSkills, type PhoneTaskSkillsSnapshot } from '../../../../apps/desktop/src/mobile/local-agent/phoneTaskSkills'
const skillId = '3e94449f-13ee-44a2-aac5-8a0bc2ff56ab'
const sessionId = '8e2660f8-cd08-4329-a045-cfe27e020b58'
const limits = { maxSkills: 20, maxNameChars: 80, maxDescriptionChars: 512, maxInstructionChars: 16384, maxTotalBytes: 131072 }
const skill = { id: skillId, name: '日历整理', description: '整理日程时使用', instructions: '实际调用日历，再按开始时间排列。', enabled: true }
const initial = (): PhoneTaskSkillsSnapshot => ({ conversationId: sessionId, revision: 4, updatedAt: null, skills: [{ ...skill }], editable: true, busy: false, limits })
let harness: ReturnType<typeof createReactHarness>
const node = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const label = (text: string) => [...harness.container.querySelectorAll<HTMLElement>('button')].find((e) => e.textContent === text || e.getAttribute('aria-label') === text)!
async function show(onClose = vi.fn()) {
  await harness.render(createNode(PhoneSkillsManager, { deviceId: 'this-phone', sessionId, busy: false, onClose }))
  await waitForCondition(() => !!node(`phone-skill-edit-${skillId}`), 'saved skill loaded')
  return onClose
}
async function editName(name: string) {
  await clickElement(node(`phone-skill-edit-${skillId}`))
  const input = node('phone-skill-name') as HTMLInputElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, name); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
beforeEach(() => { vi.clearAllMocks(); rpc.available = true; rpc.read.mockResolvedValue(initial()); rpc.save.mockImplementation(async (_device, _session, _revision, skills) => ({ ...initial(), revision: 5, skills })); harness = createReactHarness() })
afterEach(() => harness.cleanup())

describe('phone task Skill configuration', () => {
  it('only reads on opening and saves the displayed revision through the real handler', async () => {
    const close = await show()
    expect(harness.container.textContent).toContain('手机 Agent')
    expect(harness.container.textContent).not.toMatch(/\bpi\b|harness/i)
    expect(rpc.save).not.toHaveBeenCalled()
    await editName('只读日历')
    expect(harness.container.textContent).not.toMatch(/\bpi\b|harness/i)
    await clickElement(node('phone-skills-save'))
    await waitForCondition(() => close.mock.calls.length === 1, 'saved before closing')
    expect(rpc.save).toHaveBeenCalledWith('this-phone', sessionId, 4, [{ ...skill, name: '只读日历' }])
  })

  it('retains the user draft on save failure, and reload requires an explicit discard', async () => {
    rpc.save.mockRejectedValueOnce(Object.assign(new Error('配置已被更新，请重新读取'), { code: 'conflict' }))
    const close = await show()
    await editName('保留这段编辑')
    await clickElement(node('phone-skills-save'))
    await waitForCondition(() => !!node('phone-skills-error'), 'save error visible')
    expect((node('phone-skill-name') as HTMLInputElement).value).toBe('保留这段编辑')
    expect(close).not.toHaveBeenCalled()
    await clickElement(label('放弃修改后重新读取'))
    expect(rpc.read).toHaveBeenCalledTimes(1)
    await clickElement(node('phone-skills-discard'))
    await waitForCondition(() => rpc.read.mock.calls.length === 2 && !!node(`phone-skill-edit-${skillId}`), 'explicit reload finished')
    expect(close).not.toHaveBeenCalled()
  })

  it('does not revive a discarded draft when reloading fails', async () => {
    rpc.save.mockRejectedValueOnce(new Error('配置冲突'))
    await show()
    await editName('已经放弃的文字')
    await clickElement(node('phone-skills-save'))
    await waitForCondition(() => !!node('phone-skills-error'), 'save conflict')
    await clickElement(label('放弃修改后重新读取'))
    rpc.read.mockRejectedValueOnce(new Error('暂时离线'))
    await clickElement(node('phone-skills-discard'))
    await waitForCondition(() => node('phone-skills-error')?.textContent === '暂时离线', 'reload failed')
    expect(harness.container.textContent).not.toContain('已经放弃的文字')
    expect((node('phone-skills-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not discard an edited document when the sheet is dismissed', async () => {
    const close = await show()
    await editName('尚未保存')
    await clickElement(node('sheet-dismiss'))
    expect(close).not.toHaveBeenCalled(); expect(rpc.save).not.toHaveBeenCalled()
    await clickElement(label('继续编辑'))
    expect((node('phone-skill-name') as HTMLInputElement).value).toBe('尚未保存')
  })

  it('does not offer writes while the runtime reports a queued/running task', async () => {
    rpc.read.mockResolvedValue({ ...initial(), busy: true, editable: false })
    await show()
    expect((node('phone-skill-add') as HTMLButtonElement).disabled).toBe(true)
    await clickElement(node(`phone-skill-edit-${skillId}`))
    expect((node('phone-skill-name') as HTMLInputElement).disabled).toBe(true)
    expect((node('phone-skills-save') as HTMLButtonElement).disabled).toBe(true)
    expect(rpc.save).not.toHaveBeenCalled()
  })

  it('keeps configuration off remote-device and non-native task headers', async () => {
    await harness.render(createNode(PhoneTaskSkills, { deviceId: 'another-phone', sessionId, online: true }))
    expect(node('phone-task-skills-open')).toBeNull()
    rpc.available = false
    await harness.render(createNode(PhoneTaskSkills, { deviceId: 'this-phone', sessionId, online: true }))
    expect(node('phone-task-skills-open')).toBeNull(); expect(rpc.read).not.toHaveBeenCalled()
  })
})

describe('Skill document import', () => {
  const file = (text: string) => ({ name: 'SKILL.md', size: new TextEncoder().encode(text).length, text: async () => text }) as File
  it('preserves the full Markdown as instructions without registering frontmatter tools', async () => {
    const body = '---\nname: 日历整理\ndescription: 整理日程时使用\nallowed-tools: [bash]\n---\n# 流程\n实际调用日历。\n'
    const imported = await importPhoneTaskSkill(file(body), limits)
    expect(imported).toMatchObject({ name: '日历整理', description: '整理日程时使用', instructions: body, enabled: true })
    expect(Object.keys(imported).sort()).toEqual(['description', 'enabled', 'id', 'instructions', 'name'])
  })
  it('rejects oversized and duplicate content instead of truncating or overwriting it', async () => {
    await expect(importPhoneTaskSkill(file('x'.repeat(16385)), limits)).rejects.toThrow('操作说明')
    expect(() => validatePhoneTaskSkills([skill, { ...skill, instructions: 'other' }], limits)).toThrow('重复')
  })
  it('uses the runtime Unicode character limit for imported instructions', async () => {
    const body = '😀'.repeat(8193)
    const imported = await importPhoneTaskSkill(file(body), limits)
    expect(imported.instructions).toBe(body)
  })
  it('rejects malformed metadata rather than silently dropping configuration', async () => {
    await expect(importPhoneTaskSkill(file('---\nname: [a, b]\n---\ntext'), limits)).rejects.toThrow('名称须为文字')
    await expect(importPhoneTaskSkill(file('---\nfalse\n---\ntext'), limits)).rejects.toThrow('开头配置须为')
  })
})

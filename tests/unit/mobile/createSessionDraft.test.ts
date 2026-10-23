import { describe, expect, it } from 'vitest'
import { composerDrafts } from '../../../apps/desktop/src/session/renderer/features/sessions/composer-drafts'
import { bindCreationDraft, mobileCreationDraftKey } from '../../../apps/desktop/src/mobile/agent-watch/create-session-draft'

function composer() {
  let text = ''
  const listeners = new Set<() => void>()
  return {
    getState: () => ({ text }),
    setText(next: string) { text = next; for (const listener of listeners) listener() },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

describe('mobile creation draft follows the first sentence', () => {
  it('returns from device choice with the edited sentence and clears the old composer', () => {
    const key = mobileCreationDraftKey('draft-device-choice')
    const first = composer()
    const binding = bindCreationDraft(first, key)
    first.setText('帮我看明天的日程')
    binding.dispose()
    expect(first.getState().text).toBe('')
    const next = composer()
    const rebound = bindCreationDraft(next, key)
    expect(next.getState().text).toBe('帮我看明天的日程')
    rebound.dispose()
  })

  it('retains an in-flight first sentence when assistant-ui has emptied its composer', () => {
    const key = mobileCreationDraftKey('draft-in-flight')
    const first = composer()
    const binding = bindCreationDraft(first, key)
    first.setText('原任务')
    first.setText('')
    binding.hold('原任务')
    binding.dispose()
    expect(composerDrafts.get(key)).toBe('原任务')
    binding.accepted('原任务')
    expect(composerDrafts.get(key)).toBe('')
  })

  it('does not erase newer typing or an edited draft when an older request succeeds', () => {
    const key = mobileCreationDraftKey('draft-late-ack')
    const first = composer()
    const binding = bindCreationDraft(first, key)
    binding.hold('旧任务')
    binding.dispose()
    const next = composer()
    const rebound = bindCreationDraft(next, key)
    next.setText('换设备后改过的新任务')
    binding.accepted('旧任务')
    expect(next.getState().text).toBe('换设备后改过的新任务')
    expect(composerDrafts.get(key)).toBe('换设备后改过的新任务')
    rebound.dispose()
  })

  it('restores a failed submission only into an empty, still-mounted composer', () => {
    const key = mobileCreationDraftKey('draft-failure')
    const first = composer()
    const binding = bindCreationDraft(first, key)
    binding.hold('失败的原任务')
    binding.restore('失败的原任务')
    expect(first.getState().text).toBe('失败的原任务')
    first.setText('我正在写的新输入')
    binding.restore('失败的原任务')
    expect(first.getState().text).toBe('我正在写的新输入')
    binding.dispose()
    binding.restore('离页后失败')
    expect(first.getState().text).toBe('')
  })

  it('separates accounts even when the same composer instance is reused', () => {
    const first = composer()
    const binding = bindCreationDraft(first, mobileCreationDraftKey('draft-owner-a'))
    first.setText('账号 A 的输入')
    binding.dispose()
    const rebound = bindCreationDraft(first, mobileCreationDraftKey('draft-owner-b'))
    expect(first.getState().text).toBe('')
    expect(composerDrafts.get(mobileCreationDraftKey('draft-owner-a'))).toBe('账号 A 的输入')
    rebound.dispose()
  })
})

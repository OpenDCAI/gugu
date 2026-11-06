import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ modal: vi.fn(), notice: vi.fn(), dismiss: vi.fn(), boundary: new AbortController(), checked: false }))
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: state.modal }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: state.notice, dismissNotice: state.dismiss }))
vi.mock('../../../../apps/desktop/src/lib/authSessionLoss', () => ({ currentAuthSessionSignal: () => state.boundary.signal }))
vi.mock('../../../../apps/desktop/src/lib/userFacingError', () => ({ messageForUser: () => 'offline' }))
import { confirmHideConversation } from '../../../../apps/desktop/src/lib/confirmHideConversation'

beforeEach(() => {
  vi.clearAllMocks()
  state.boundary = new AbortController()
  state.checked = false
  state.modal.mockImplementation((_kind, options) => options.onSuccess({ optionChecked: state.checked }))
})
describe('shared Agent hide confirmation', () => {
  it('defaults Agent removal to unchecked and only hides on confirmation', async () => {
    const hide = vi.fn().mockResolvedValue(undefined), remove = vi.fn()
    await confirmHideConversation({ hide, ownedAgent: { id: 'agent', remove } })
    expect(state.modal.mock.calls[0][1].option.defaultChecked).toBe(false)
    expect(hide).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
  })
  it('does nothing when cancelled and hides other conversations without an Agent option', async () => {
    const hide = vi.fn().mockResolvedValue(undefined)
    state.modal.mockImplementation((_kind, options) => options.onClose())
    await confirmHideConversation({ hide, ownedAgent: { id: 'agent', remove: vi.fn() } })
    expect(hide).not.toHaveBeenCalled()
    await confirmHideConversation({ hide })
    expect(hide).toHaveBeenCalledTimes(1)
    expect(state.modal).toHaveBeenCalledTimes(1)
  })
  it('shows a separate Agent retry after partial success, and retry leaves a restored row alone', async () => {
    state.checked = true
    const hide = vi.fn().mockResolvedValue(undefined)
    const remove = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    await confirmHideConversation({ hide, ownedAgent: { id: 'agent', remove } })
    const notice = state.notice.mock.calls[0][0]
    expect(notice.ongoing).toBe(true)
    expect(notice.title).toBe('已从列表删除，但 Agent 删除失败')
    notice.action.onClick()
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
    expect(hide).toHaveBeenCalledTimes(1)
  })
  it('drops the retry when its account session ends', async () => {
    state.checked = true
    const hide = vi.fn().mockResolvedValue(undefined), remove = vi.fn().mockRejectedValue(new Error('offline'))
    await confirmHideConversation({ hide, ownedAgent: { id: 'agent', remove } })
    state.boundary.abort()
    state.notice.mock.calls[0][0].action.onClick()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(state.dismiss).toHaveBeenCalled()
  })
})

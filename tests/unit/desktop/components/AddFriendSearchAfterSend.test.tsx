// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddFriendSearch } from '../../../../apps/desktop/src/components/AddFriendSearch'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders, typeInto, waitForCondition } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

// 发出好友申请后：离开这一页（onBack：弹窗关掉 / 手机整页返回），搜索框与结果清空，不再留着上一次的输入。
describe('AddFriendSearch after a request is sent', () => {
  it('clears the query and results, then hands back to the host', async () => {
    const sendRequest = vi.fn(async () => {})
    const clearSearch = vi.fn()
    const onBack = vi.fn()
    await renderWithAppProviders(harness, createNode(AddFriendSearch, { onBack }), {
      contacts: {
        contacts: [],
        sentRequests: [],
        searchResults: [contact({ id: 'bob', display_name: 'Bob' })],
        clearSearch,
        sendRequest,
      },
    })

    const input = harness.container.querySelector('input') as HTMLInputElement
    await typeInto(input, 'Bob')
    const addButton = Array.from(harness.container.querySelectorAll('.gg-row button'))[0] as HTMLButtonElement
    await clickElement(addButton)

    // 附言框下面那一行是「取消 / 发送」;Sheet 自己还有一个关闭钮,所以按行取,❌ 取整个弹窗的最后一个按钮。
    const dialog = document.body.querySelector('[data-testid="friend-request-note-dialog"]') as HTMLElement
    const actions = dialog.querySelector('textarea')?.nextElementSibling as HTMLElement
    const send = [...actions.querySelectorAll('button')].pop() as HTMLButtonElement
    await clickElement(send)

    await waitForCondition(() => onBack.mock.calls.length === 1, 'onBack not called')
    expect(sendRequest).toHaveBeenCalledWith('bob', '')
    expect(clearSearch).toHaveBeenCalled()
    expect(input.value).toBe('')
    expect(harness.container.querySelector('.gg-row')).toBeNull()
  })
})

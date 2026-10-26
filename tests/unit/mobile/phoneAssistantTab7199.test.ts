import { describe, expect, it } from 'vitest'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import { SIDEBAR_TABS, mobileTabs } from '@gugu/core/shared/enums/sidebarTabModels'
import { phoneAssistantStage } from '../../../apps/desktop/src/mobile/assistant/phoneAssistantStage'
import { settledTab, tabPosition } from '../../../apps/desktop/src/mobile/settledTab'

// #7199 owner 10-16「助理是咕咕底栏里的一格」:这一格排第一,分页器与底栏同一份顺序;手机壳里一直有(没有咕咕的新用户那一格里是引导)。
describe('mobileTabs', () => {
  it('puts the assistant first when the shell shows it, and leaves the four tabs alone otherwise', () => {
    expect(mobileTabs(true)).toEqual(['assistant', 'tasks', 'chats', 'contacts', 'settings'])
    expect(mobileTabs(false)).toEqual(SIDEBAR_TABS)
  })

  it('lets the pager settle on the assistant page and on the last page of the longer list', () => {
    const tabs = mobileTabs(true)
    expect(settledTab(0, 390, tabs)).toBe('assistant')
    expect(settledTab(390, 390, tabs)).toBe('tasks')
    expect(settledTab(4 * 390, 390, tabs)).toBe('settings')
    expect(settledTab(5 * 390, 390, tabs)).toBeNull()
    expect(tabPosition(5 * 390, 390, tabs.length)).toBe(4)
  })
})

const NONE = { loading: false, agentId: null, error: null }
const base = { found: false, chatId: null, chatFailed: null, retryChat: () => {}, snapshot: null, cloudKnown: false, cloudLoadFailed: false, identity: NONE }
const snapshot = (state: CloudComputerSnapshot['state'], deviceId: string | null = 'cloud-1') => ({ state, deviceId }) as CloudComputerSnapshot

// 那一格还打不开聊天时说是哪一步:读不到 ≠ 没开通 ≠ 没有它(规定「入口」「它是谁」两节)。
describe('phoneAssistantStage', () => {
  it('is the app itself once it and its chat are both there', () => {
    expect(phoneAssistantStage({ ...base, found: true, chatId: 'dm-1' })).toEqual({ stage: 'ready' })
  })

  it('says the chat is opening, or could not be opened (with a retry)', () => {
    expect(phoneAssistantStage({ ...base, found: true }).stage).toBe('chat-opening')
    const retry = () => {}
    expect(phoneAssistantStage({ ...base, found: true, chatFailed: { error: 'network denied' }, retryChat: retry })).toEqual({ stage: 'chat-failed', error: 'network denied', retry })
  })

  it('does not turn an unread or unreadable state into onboarding', () => {
    expect(phoneAssistantStage(base).stage).toBe('cloud-loading')
    expect(phoneAssistantStage({ ...base, cloudLoadFailed: true }).stage).toBe('cloud-unreadable')
  })

  it('shows the setup guide to a new user with no assistant, whatever the butler has said (cell stays in the bar)', () => {
    // 管家答了「没有云电脑 / 这里没开放」:没有快照,但已经知道了 ⇒ 引导(手机上装不了,引导里如实说)。
    expect(phoneAssistantStage({ ...base, cloudKnown: true })).toEqual({ stage: 'onboarding', snapshot: null })
    expect(phoneAssistantStage({ ...base, cloudKnown: true, snapshot: snapshot('none', null) }).stage).toBe('onboarding')
    // 正在准备 / 出错重来:同一格里的引导自己画进度。
    expect(phoneAssistantStage({ ...base, cloudKnown: true, snapshot: snapshot('provisioning') }).stage).toBe('onboarding')
    expect(phoneAssistantStage({ ...base, cloudKnown: true, snapshot: snapshot('error') }).stage).toBe('onboarding')
  })

  it('tells reading who it is apart from it not being there and from not being able to read', () => {
    const open = { ...base, cloudKnown: true, snapshot: snapshot('awake') }
    expect(phoneAssistantStage({ ...open, identity: { loading: true, agentId: null, error: null } })).toEqual({ stage: 'identity', state: 'loading' })
    // 标记读到了、通讯录里还没有那一位:还在读,❌「没有」。
    expect(phoneAssistantStage({ ...open, identity: { loading: false, agentId: 'agent-1', error: null } })).toEqual({ stage: 'identity', state: 'loading' })
    // 读不到 ≠ 没有:❌ 送进引导再建一个。
    expect(phoneAssistantStage({ ...open, identity: { loading: false, agentId: null, error: 'network' } })).toEqual({ stage: 'identity', state: 'unreadable' })
    expect(phoneAssistantStage({ ...base, identity: { loading: false, agentId: null, error: 'network' } })).toEqual({ stage: 'identity', state: 'unreadable' })
  })
})

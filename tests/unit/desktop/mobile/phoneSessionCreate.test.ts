import { describe, expect, it } from 'vitest'
import { forgetPhoneSessionCreate, readPhoneSessionCreate, rememberPhoneSessionCreate } from '../../../../apps/desktop/src/mobile/local-agent/phoneSessionCreate'
import { rememberPhoneAgentCreateAttempt } from '../../../../apps/desktop/src/mobile/local-agent/phoneAgentCreate'

function memoryStorage() {
  const entries = new Map<string, string>()
  return { entries, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) }, removeItem: (key: string) => { entries.delete(key) } }
}
const request = { clientRequestId: 'same-request', harness: 'pi', prompt: '查今天日程', model: 'platform:model', chatId: 'group' }

describe('shared composer keeps phone creation intent on a lost reply', () => {
  it('restores the exact request across reload, isolated by owner and device', () => {
    const storage = memoryStorage()
    rememberPhoneSessionCreate('owner', 'phone', request, storage)
    expect(readPhoneSessionCreate('owner', 'phone', storage)).toEqual(request)
    expect(readPhoneSessionCreate('other', 'phone', storage)).toBeNull()
    expect(readPhoneSessionCreate('owner', 'other', storage)).toBeNull()
    expect(() => rememberPhoneSessionCreate('owner', 'phone', { ...request, prompt: '换任务' }, storage)).toThrow('同一次创建')
    expect(readPhoneSessionCreate('owner', 'phone', storage)).toEqual(request)
    forgetPhoneSessionCreate('owner', 'phone', request, storage)
    expect(readPhoneSessionCreate('owner', 'phone', storage)).toBeNull()
  })

  it('migrates an unconfirmed prototype request with its name, group and id unchanged', () => {
    const storage = memoryStorage()
    rememberPhoneAgentCreateAttempt({ version: 1, id: 'legacy-id', ownerId: 'owner', deviceId: 'phone', name: ' 手机助手 ', prompt: ' 读日程 ', model: 'platform:model', chatId: 'group' }, storage)
    const migrated = readPhoneSessionCreate('owner', 'phone', storage)!
    expect(migrated).toEqual({ clientRequestId: 'legacy-id', title: '手机助手', harness: 'pi', prompt: '读日程', model: 'platform:model', sessionView: 'general', chatId: 'group' })
    rememberPhoneSessionCreate('owner', 'phone', migrated, storage)
    forgetPhoneSessionCreate('owner', 'phone', migrated, storage)
    expect(storage.entries.size).toBe(0)
  })

  it('does not discard corrupted or concurrently replaced records', () => {
    const storage = memoryStorage()
    rememberPhoneSessionCreate('owner', 'phone', request, storage)
    expect(() => forgetPhoneSessionCreate('owner', 'phone', { ...request, clientRequestId: 'different' }, storage)).toThrow('记录已经改变')
    const [key] = storage.entries.keys()
    storage.setItem(key!, '{broken')
    expect(() => readPhoneSessionCreate('owner', 'phone', storage)).toThrow()
    expect(storage.getItem(key!)).toBe('{broken')
  })
})

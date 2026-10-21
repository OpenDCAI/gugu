import { describe, expect, it } from 'vitest'
import { composeInstructions, joinPersona, splitInstructions, splitPersona } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'
import {
  connectorDetail,
  connectorGroups,
  customizePlan,
  personaChipKey,
  thisDeviceView,
} from '../../../apps/desktop/src/mobile/assistant/phoneProfileModel'

// #7199 手机 <它的名字> 那一格:与桌面同一套说法,读不到时不冒充「没设置」,保存只写真动过、真读到的。
describe('personaChipKey', () => {
  it('读到了照桌面:预设名 / 自定义性格 / 设置性格', () => {
    expect(personaChipKey({ preset: 'warm', rest: '' })).toBe('customize.preset.warm')
    expect(personaChipKey({ preset: null, rest: '说话短一点' })).toBe('customize.custom')
    expect(personaChipKey({ preset: null, rest: '' })).toBe('customize.setCharacter')
  })

  it('还没读到(在休息、读失败)只说「性格」,❌「设置性格」', () => {
    expect(personaChipKey(null)).toBe('customize.character')
  })
})

describe('customizePlan', () => {
  const base = { draftName: '小咕', currentName: '小咕', personaTouched: false, personaReadable: true }

  it('名字没变、性格没动:什么都不写,但能按保存', () => {
    expect(customizePlan(base)).toEqual({ rename: null, writePersona: false, canSave: true })
  })

  it('名字前后空白去掉再比;变了才改名', () => {
    expect(customizePlan({ ...base, draftName: '  小咕 ' }).rename).toBeNull()
    expect(customizePlan({ ...base, draftName: ' 阿咕 ' }).rename).toBe('阿咕')
  })

  it('空名字不许存', () => {
    expect(customizePlan({ ...base, draftName: '   ' })).toEqual({ rename: null, writePersona: false, canSave: false })
  })

  it('性格动过、且读到过原文才写;没读到就写 = 拿空白盖掉它原来的性格', () => {
    expect(customizePlan({ ...base, personaTouched: true }).writePersona).toBe(true)
    expect(customizePlan({ ...base, personaTouched: true, personaReadable: false }).writePersona).toBe(false)
  })
})

describe('性格写回(手机与桌面同一套拼装)', () => {
  it('宿主维护那段原样留着,人写的接在后面;清空 = 只剩维护那段', () => {
    const managed = '<!-- 咕咕管家 -->\n你是谁\n<!-- /咕咕管家 -->'
    const current = `${managed}\n\n性格：温暖\n旧描述\n`
    const next = composeInstructions(current, joinPersona('direct', '少说废话'))
    expect(next.startsWith(managed)).toBe(true)
    expect(splitPersona(splitInstructions(next).user)).toEqual({ preset: 'direct', rest: '少说废话' })
    expect(composeInstructions(current, joinPersona(null, ''))).toBe(`${managed}\n`)
  })
})

describe('connectorGroups', () => {
  const items = [
    { id: 'github', description: 'Code' },
    { id: 'feishu', description: '飞书' },
    { id: 'dingtalk', description: '钉钉' },
  ]

  it('按存没存凭据分组;已连接写账号名,还没问到写介绍', () => {
    const groups = connectorGroups(items, { github: true, feishu: true }, { github: { displayName: 'octocat' } }, 'en-US')
    expect(groups.connected.map(({ item, detail }) => [item.id, detail])).toEqual([
      ['github', 'octocat'],
      ['feishu', '飞书'],
    ])
    expect(groups.available.map(({ item }) => item.id)).toEqual(['dingtalk'])
  })

  it('中文界面国内常用的在前(与桌面同一个 connectorOrder)', () => {
    const groups = connectorGroups(items, {}, null, 'zh-CN')
    expect(groups.available.map(({ item }) => item.id)).toEqual(['feishu', 'dingtalk', 'github'])
  })
})

describe('connectorDetail', () => {
  const items = [{ id: 'github', description: 'Code' }]

  it('连没连、账号名', () => {
    expect(connectorDetail(items, { github: true }, { github: { displayName: 'octocat' } }, 'github')).toEqual({ item: items[0], connected: true, account: 'octocat' })
    expect(connectorDetail(items, {}, null, 'github')).toEqual({ item: items[0], connected: false, account: null })
  })

  it('目录里没有 = null(页面说「此应用不可用」)', () => {
    expect(connectorDetail(items, {}, null, 'feishu')).toBeNull()
  })
})

describe('thisDeviceView', () => {
  it('装在手机上的咕咕画这台手机;网页版交给桌面同一个组件(它说要在电脑 App 里连)', () => {
    expect(thisDeviceView('capacitor')).toBe('phone')
    expect(thisDeviceView('web')).toBe('shared')
  })
})

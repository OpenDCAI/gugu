// @vitest-environment jsdom
import { act, createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { AgentJoinPage } from '../../../../apps/desktop/src/pages/AgentJoinPage'
import { TemplateRoleMarker } from '../../../../apps/desktop/src/components/TemplateRoleMarker'
import { displayAvatarUrl } from '../../../../apps/desktop/src/lib/dicebearAvatar'
import { dicebearAvatarDataUri } from '../../../../apps/desktop/src/lib/dicebearAvatar'
import { Avatar } from '../../../../apps/desktop/src/components/Avatar'
import { presetTeamToAgentTeam } from '../../../../apps/desktop/src/lib/presetTeams'
import { loadPresetTeamCatalogFixture } from '../../../support/presetTeamCatalogFixture'
const PRESET_TEAMS = loadPresetTeamCatalogFixture()
// #2470 身份边界：产品里只有两类视觉。
//   身份投影 —— 自定义头像逐字，或按稳定 id 生成的默认脸；
//   非身份 —— 署名文字、显式的模板标记。两者不得互相冒充。
const GENERATED = 'data:image/svg+xml'
/** 数整页里生成脸(默认脸 SVG)的总数,用来判断署名行有没有多出一张。agent 自己的头像位是小鸟 canvas,不在这个数里。 */
function generatedFaceCount(html: string): number {
  return html.split(GENERATED).length - 1
}
function joinPage(ownerAvatar: string | null) {
  return renderToString(createElement(AgentJoinPage, {
    agent: {
      id: 'agent-1',
      displayName: 'Codex 1',
      avatar: null,
      bio: null,
      ownerDisplayName: '阿力',
      ownerAvatar,
    },
    onStartChat: vi.fn(),
    onRequireLogin: vi.fn(),
    isLoggedIn: false,
  }))
}
describe('公开加入页的 owner 行是署名，不是身份投影', () => {
  it('owner 没有真上传头像时，头像位整个不渲染——不给空圈，也不生成脸', () => {
    const html = joinPage(null)
    expect(html, '署名文字仍在').toContain('阿力')
    // agent 自己的头像位是身份投影:没上传 → 咕咕小鸟(canvas),一只;署名行不得再多出任何一张生成脸。
    expect(html.split('data-agent-avatar-boring=').length - 1, 'the agent default SVG').toBe(1)
    expect(generatedFaceCount(html), '署名行不得生成脸').toBe(0)
    expect(html, '也不得留一个空头像位').not.toContain('data-avatar-empty')
  })
  it('owner 真上传过头像时逐字渲染', () => {
    const uploaded = 'https://db.example/storage/v1/object/public/avatars/owner.png'
    expect(joinPage(uploaded)).toContain(uploaded)
  })
})
describe('模板角色标记是显式的非身份视觉', () => {
  it('不渲染任何头像图片，也不生成脸', () => {
    const html = renderToString(createElement(TemplateRoleMarker, { roleKey: 'curator', templateLabel: '行程主理人（角色模板）' }))
    expect(html).toContain('data-template-role-marker')
    expect(html, '模板标记绝不能走 Avatar/DiceBear').not.toContain(GENERATED)
    expect(html, '模板标记不渲染 img').not.toContain('<img')
    expect(html, '语义上要自报是模板').toContain('角色模板')
  })
  it('同一角色 key 永远同一个字形，且与显示名解耦（改名不变）', () => {
    const glyph = (html: string) => html.match(/<svg[^>]*>(.*?)<\/svg>/s)?.[1] ?? ''
    const a = glyph(renderToString(createElement(TemplateRoleMarker, { roleKey: 'curator', templateLabel: '行程主理人（角色模板）' })))
    const renamed = glyph(renderToString(createElement(TemplateRoleMarker, { roleKey: 'curator', templateLabel: '改了个名（角色模板）' })))
    expect(a).toBe(renamed)
    // 注意：字形池是有限的，不同 key 撞同一个字形是允许的 —— 模板标记本来就不承担
    // 「区分身份」的职责（那是身份头像的事）。所以这里**不**断言不同 key 必然不同字形。
    const glyphs = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((k) =>
      glyph(renderToString(createElement(TemplateRoleMarker, { roleKey: k, templateLabel: 't (role template)' })))))
    expect(glyphs.size, '字形应真的按 key 分散，而不是恒定一个').toBeGreaterThan(1)
  })
})
describe('displayAvatarUrl 的口径', () => {
  it('自定义头像原样返回', () => {
    const url = 'https://db.example/storage/v1/object/public/avatars/a.png'
    expect(displayAvatarUrl(url, 'id-1')).toBe(url)
  })
  it('没有头像 → 按稳定 id 生成，且与 id 绑定', () => {
    const bare = displayAvatarUrl(null, 'id-1')
    expect(bare).toContain(GENERATED)
    expect(displayAvatarUrl(null, 'id-2'), '不同身份不撞脸').not.toBe(bare)
  })
  it('缺身份 key → null，绝不拿名字造脸', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(displayAvatarUrl(null, null)).toBeNull()
    expect(displayAvatarUrl(null, '   ')).toBeNull()
  })
  it('脏哨兵串 → null（fail loud），不映射成生成脸', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(displayAvatarUrl('undefined', 'id-1')).toBeNull()
    expect(displayAvatarUrl('null', 'id-1')).toBeNull()
  })
})
describe('review3 回归钉', () => {
  it('R3-2 模板 key 全局唯一：不同团队的同名角色不得共用一个 key', () => {
    const seeds = PRESET_TEAMS.flatMap((team) => team.roles.map((r) => r.avatarSeed))
    expect(seeds.every((s) => typeof s === 'string' && s.trim().length > 0), '每个角色都要有 avatarSeed').toBe(true)
    expect(new Set(seeds).size, 'avatarSeed 必须全局唯一（role.key 只在团队内唯一，会跨团队撞）').toBe(seeds.length)
  })
  it('R3-3 群没有稳定 id 是正常的，不得被诊断成「缺身份 key 的人」', async () => {
    const harness = createReactHarness()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    errorSpy.mockClear()
    try {
      await harness.render(createNode(Avatar, { name: '协作群', variant: 'group' }))
      await act(async () => { await Promise.resolve() })
      expect(errorSpy, '群不该触发 missing identity key 诊断').not.toHaveBeenCalled()
      expect(harness.container.querySelector('img'), '群也不该拿到一张人脸').toBeNull()
    } finally {
      harness.cleanup()
      errorSpy.mockRestore()
    }
  })
  it('R3-3 对照：个人身份缺稳定 id 时必须发诊断', async () => {
    const harness = createReactHarness()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    errorSpy.mockClear()
    try {
      await harness.render(createNode(Avatar, { name: '某人' }))
      await act(async () => { await Promise.resolve() })
      expect(errorSpy).toHaveBeenCalledWith(
        '[Avatar] missing identity key for "某人" — a generated default face needs a stable id; display name must never seed it',
      )
    } finally {
      harness.cleanup()
      errorSpy.mockRestore()
    }
  })
  it('R3-5 空身份 key 必须抛错，绝不造一张共用的兜底脸', () => {
    expect(() => dicebearAvatarDataUri('')).toThrow(/stable identity key/)
    expect(() => dicebearAvatarDataUri('   ')).toThrow(/stable identity key/)
  })
  it('R3-5 群组合里纯空白的成员 id 留空槽，而不是共用脸', () => {
    const html = renderToString(createElement(Avatar, {
      name: '群',
      variant: 'group',
      memberAvatars: [{ id: '   ', name: '空白 id', avatar: null }],
    }))
    expect(html).toContain('data-avatar-empty')
    expect(html).not.toContain(GENERATED)
  })
  it('R3-4 脏哨兵串在署名行也要被诊断，不能因为不渲染头像位就吞掉', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    errorSpy.mockClear()
    joinPage('undefined')
    expect(errorSpy, '公开加入页的 owner 行必须走共享入口并 fail loud').toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
// 裁决 guard：avatarSeed 变必填后，**每个**构造点都必须在运行时真给得出稳定槽位 key。
describe('模板 key 的所有构造点都给得出稳定槽位 key', () => {
  it('预设团队构造点：每个成员都有非空 avatarSeed，且不由显示名派生', () => {
    for (const team of PRESET_TEAMS) {
      for (const member of presetTeamToAgentTeam(team).members) {
        expect(member.avatarSeed?.trim(), `${team.name}/${member.displayName} 缺模板 key`).toBeTruthy()
        expect(member.avatarSeed, '模板 key 不得等于显示名').not.toBe(member.displayName)
      }
    }
  })
  it('模板 key 缺失时 fail loud，绝不静默或用名字兜', () => {
    expect(() => renderToString(createElement(TemplateRoleMarker, { roleKey: '', templateLabel: 'x' })))
      .toThrow(/stable template\/blueprint slot key/)
    expect(() => renderToString(createElement(TemplateRoleMarker, { roleKey: '  ', templateLabel: 'x' })))
      .toThrow(/stable template\/blueprint slot key/)
  })
})

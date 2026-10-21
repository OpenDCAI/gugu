// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Avatar } from '../../../../apps/desktop/src/components/Avatar'
import { SessionAvatar } from '../../../../apps/desktop/src/mobile/agent-watch/StatusGlyph'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { BODY_COLORS, agentIdentity } from '../../../../apps/desktop/src/components/agentAvatar/engine/identity'

// agent 没上传头像 → 默认脸是咕咕小鸟(canvas,状态靠身体变形);真人 / 群 / 上传了图的 agent 不变。
const UPLOAD = 'https://db.example/storage/v1/object/public/avatars/a.png'
const GENERATED = 'data:image/svg+xml'
const render = (props: Record<string, unknown>) =>
  renderToString(createElement(Avatar, { name: 'Agent', seed: 'agent-1', size: 'md', ...props } as never))

describe('Avatar · agent default face is the animated bird', () => {
  it('agent without an upload → a bird canvas, no generated face, no corner status badge', () => {
    const html = render({ isAgent: true, agentStatus: 'working' })
    expect(html).toContain('data-agent-avatar=""')
    expect(html).toContain('data-agent-avatar-state="running"')
    expect(html).not.toContain(GENERATED)
    expect(html, '状态在身体上,不再挂角标').not.toContain('av-status')
  })

  it('the exact label wins over the coarse status (needs_user alone cannot say what it waits for)', () => {
    const html = render({ isAgent: true, agentStatus: 'needs_user', statusLabel: 'needsApproval' })
    expect(html).toContain('data-agent-avatar-state="needsApproval"')
  })

  it('no status given → the bird at rest, no state attribute', () => {
    const html = render({ isAgent: true })
    expect(html).toContain('data-agent-avatar=""')
    expect(html).not.toContain('data-agent-avatar-state')
  })

  it('agent WITH an upload → that picture, and the corner badge still carries the status', () => {
    const html = render({ isAgent: true, avatarUrl: UPLOAD, agentStatus: 'working' })
    expect(html).toContain(UPLOAD)
    expect(html).not.toContain('data-agent-avatar=""')
    expect(html).toContain('av-status--working')
  })

  it('agent with a stored look (颜色 + 休息表情) → the bird in that look, the URL is never loaded as a picture', () => {
    const look = 'https://db.example/storage/v1/object/public/avatars/agent-look/v1/sakura.webp?rest=shy'
    const html = render({ isAgent: true, avatarUrl: look, agentStatus: 'working' })
    expect(html).toContain('data-agent-avatar=""')
    expect(html).toContain('data-agent-avatar-color="sakura"')
    expect(html).toContain('data-agent-avatar-rest="shy"')
    expect(html).not.toContain(look)
    expect(html, '形象也是小鸟:状态在身体上,不挂角标').not.toContain('av-status')
  })

  it('a human never turns into the moving bird, even if a look URL lands on them (static still of that colour)', () => {
    const look = 'https://db.example/storage/v1/object/public/avatars/agent-look/v1/sakura.webp?rest=shy'
    const html = render({ isAgent: false, avatarUrl: look })
    expect(html).not.toContain('data-agent-avatar=""')
    expect(html).not.toContain(look)
    expect(html).toContain('<img')
  })

  it('human without an upload keeps the generated face', () => {
    const html = render({ isAgent: false })
    expect(html).toContain(GENERATED)
    expect(html).not.toContain('data-agent-avatar=""')
  })

  it('an agent without a stable id is the diagnosable empty state, not a bird', () => {
    const html = render({ isAgent: true, seed: '' })
    expect(html).toContain('data-avatar-empty')
    expect(html).not.toContain('data-agent-avatar=""')
  })

  it('a group is never a bird', () => {
    const html = render({ isAgent: true, variant: 'group' })
    expect(html).not.toContain('data-agent-avatar=""')
  })
})

// #7243 群聊消息旁一条消息一只:still = 同一只小鸟的定格图,不进每帧绘制;定格说不出状态,状态回到右上角角标。
describe('Avatar · still bird (message list)', () => {
  it('agent without an upload → its still, no canvas; the corner badge carries the status', () => {
    const id = '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
    const html = render({ isAgent: true, seed: id, agentStatus: 'working', still: true })
    expect(html).not.toContain('<canvas')
    expect(html).toContain(`data-agent-avatar-still="${BODY_COLORS[agentIdentity(id).color].en.toLowerCase()}"`)
    expect(html).toContain('av-status--working')
  })

  it('agent with a stored look → the still of that colour; the look URL is never loaded', () => {
    const look = 'https://db.example/storage/v1/object/public/avatars/agent-look/v1/sakura.webp?rest=shy'
    const html = render({ isAgent: true, avatarUrl: look, still: true })
    expect(html).not.toContain('<canvas')
    expect(html).toContain('data-agent-avatar-still="sakura"')
    expect(html).not.toContain(look)
  })

  it('still changes nothing for humans and uploaded pictures', () => {
    expect(render({ isAgent: false, still: true })).toContain(GENERATED)
    expect(render({ isAgent: true, avatarUrl: UPLOAD, still: true })).toContain(UPLOAD)
  })
})

describe('phone SessionAvatar', () => {
  it('draws the state of the shared presentation table', () => {
    const presentation = presentAgentStatus({ reading: { status: 'error', detail: null } })
    const html = renderToString(createElement(SessionAvatar, { sessionId: 'conv-1', presentation }))
    expect(html).toContain('data-agent-avatar-state="error"')
  })

  it('no presentation (machine offline snapshot) → "unavailable", never "running" or "idle"', () => {
    const html = renderToString(createElement(SessionAvatar, { sessionId: 'conv-1', presentation: null }))
    expect(html).toContain('data-agent-avatar-state="none"')
  })
})

describe('sessions without a gugu identity are not all the same bird', () => {
  it('phone rows key the look off the session id, so different sessions differ', () => {
    const attr = (sessionId: string) =>
      /data-agent-avatar-color="([^"]+)"/.exec(renderToString(createElement(SessionAvatar, { sessionId, presentation: null })))?.[1]
    const colors = new Set(Array.from({ length: 24 }, (_, i) => attr(`session-${i}-${i * 104729}`)))
    expect(colors.size).toBeGreaterThanOrEqual(6)
    expect(attr('session-7')).toBe(attr('session-7'))
  })
})

describe('identity layer reaches every surface', () => {
  const attrs = (html: string) => ({
    color: /data-agent-avatar-color="([^"]+)"/.exec(html)?.[1],
    rest: /data-agent-avatar-rest="([^"]+)"/.exec(html)?.[1]
  })

  it('the same agent id is the same colour + rest face in chat (Avatar) and on the phone (SessionAvatar)', () => {
    const id = '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
    const want = agentIdentity(id)
    const chat = attrs(render({ isAgent: true, seed: id }))
    const phone = attrs(
      renderToString(createElement(SessionAvatar, { agentId: id, sessionId: 'conv-1', presentation: presentAgentStatus({ reading: { status: 'idle', detail: null } }) }))
    )
    expect(chat).toEqual({ color: BODY_COLORS[want.color].en.toLowerCase(), rest: want.rest })
    expect(phone).toEqual(chat)
  })

  it('different agents get their own identity (not all the same bird)', () => {
    const ids = Array.from({ length: 24 }, (_, i) => `agent-${i}-${i * 7919}`)
    const colors = new Set(ids.map((id) => attrs(render({ isAgent: true, seed: id })).color))
    expect(colors.size).toBeGreaterThanOrEqual(6)
  })
})

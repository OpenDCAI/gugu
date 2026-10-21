import { describe, expect, it } from 'vitest'
import { codexForkHandoffItems } from '../../../../apps/desktop/electron/runtime/codex-fork-handoff.mjs'

/**
 * @@@fork-identity codex 不认 `thread/fork` 带的新 developerInstructions(openai/codex#19045),分叉出来的
 * 新 agent 会顶着源 agent 的身份跑。修法是 fork 后注入一条开发者消息 —— 这里钉住它**装什么、不装什么**。
 */
describe('@@@fork-identity 分叉交接消息', () => {
  const PLATFORM = '<gugu_platform>\nYou are participating in 咕咕 (Gugu) …\n</gugu_platform>\n'
  const IDENTITY = '<agent_identity reason="new_acp_session">\nparticipant_id: user-9\ndisplay_name: Codex 9\n</agent_identity>\n'
  const FOCUS = '<special_focus reason="creator_directive">\n你的具体目标:写文档\n</special_focus>\n'
  const textOf = (items: ReturnType<typeof codexForkHandoffItems>) => items[0]!.content[0]!.text

  it('是一条 developer 消息:交接说明 + 新身份块(+ 专注方向),❌ 不重发平台提示词', () => {
    const items = codexForkHandoffItems(PLATFORM + IDENTITY + FOCUS)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'message', role: 'developer' })
    const text = textOf(items)
    expect(text).toContain('display_name: Codex 9')
    expect(text).toContain('你的具体目标:写文档')
    expect(text).not.toContain('gugu_platform')
  })

  it('交接说明:上文身份属于源 agent;先别接着干源会话的活,等新任务', () => {
    const text = textOf(codexForkHandoffItems(IDENTITY))
    expect(text).toContain('any identity stated there belonged to the source agent and no longer applies to you')
    expect(text).toContain('Do not resume or continue the source conversation')
    expect(text).toContain('wait for your new instructions')
    // 交接说明在前、身份在后:「以下面这段为准」必须指得到东西
    expect(text.indexOf('<fork_handoff')).toBeLessThan(text.indexOf('<agent_identity'))
  })

  it('没有专注方向就不带那一段', () => {
    expect(textOf(codexForkHandoffItems(IDENTITY))).not.toContain('special_focus')
  })

  it('取不到身份块 ⇒ THROW(那正是本缺陷的症状,❌ 不许静默放过)', () => {
    expect(() => codexForkHandoffItems(PLATFORM)).toThrow(/agent_identity/)
    expect(() => codexForkHandoffItems(undefined)).toThrow(/agent_identity/)
  })
})

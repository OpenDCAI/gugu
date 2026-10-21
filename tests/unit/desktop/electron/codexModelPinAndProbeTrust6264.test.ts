import { describe, expect, it } from 'vitest'
import {
  CodexAppServerSession,
  codexArgvConfigPins,
  codexTuiModelSelectionArgs,
  codexTuiThreadSettingsArgs,
  codexTurnSignInRequired,
} from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'
import { stripGuguProbeTrustEntries } from '../../../../apps/desktop/electron/session/main/core/agents/codex-probe-trust-scrub'

/**
 * #6264 d22 实机:composer 选了「咕咕 GPT-5.6 Luna」,app-server 起在 `-c model="gpt-5.6-luna"` 上,
 * 可 TUI(`codex --remote`)建 thread 时发的是用户 config.toml 里的 `gpt-6-astra xhigh`,中转 403。
 */
const ENDPOINT = { kind: 'unix', address: 'unix:///tmp/x.sock', socketPath: '/tmp/x.sock' }
const APP_SERVER_ARGS = [
  '-c', 'projects={ "/w" = { trust_level = "trusted" } }',
  '-c', 'model="gpt-5.6-luna"',
  '-c', 'model_reasoning_effort="medium"',
  '-c', 'model_context_window=272000',
  '-c', 'model_provider=gugu_platform',
]

describe('#6264 用户选的模型钉给建 thread 的 TUI', () => {
  it('从 app-server argv 取出模型 / 推理强度 / 服务档,逐字原样', () => {
    expect(codexTuiModelSelectionArgs(APP_SERVER_ARGS))
      .toEqual(['-c', 'model="gpt-5.6-luna"', '-c', 'model_reasoning_effort="medium"'])
    expect(codexTuiModelSelectionArgs(['-c', 'service_tier="flex"', '-c', 'model=gpt-x']))
      .toEqual(['-c', 'model=gpt-x', '-c', 'service_tier="flex"'])
  })

  it('同键取最后一格(与 codex 自己「后给的 -c 覆盖先给的」一致,用户在设置里补的参数排在后面)', () => {
    expect(codexArgvConfigPins(['-c', 'model="a"', '--config', 'model="b"'], ['model'])).toEqual(['-c', 'model="b"'])
  })

  it('没选模型 ⇒ 不钉(交给 codex 自己解析)', () => {
    expect(codexTuiModelSelectionArgs(['-c', 'model_context_window=1'])).toEqual([])
    expect(codexTuiModelSelectionArgs(undefined)).toEqual([])
  })

  it('不把别的 -c 误当成模型键(provider、MCP、信任都不进 TUI 的模型钉)', () => {
    expect(codexArgvConfigPins(['-c', 'model_provider=gugu_platform', '-c', 'models.x=1'], ['model'])).toEqual([])
  })

  it('工作目录的按次信任也给 TUI(否则它弹「信任此目录?」、用户点了就写进他的 config.toml)', () => {
    const session = new CodexAppServerSession('agent-trust-pin', '/unused/codex')
    Object.assign(session as unknown as Record<string, unknown>, { threadId: 'tid', endpoint: ENDPOINT })
    ;(session as unknown as { modelMetadataArgs: string[] }).modelMetadataArgs = codexArgvConfigPins(APP_SERVER_ARGS, ['model_context_window', 'projects'])
    const args = session.remoteTuiArgs()
    expect(args).toContain('projects={ "/w" = { trust_level = "trusted" } }')
    expect(args).toContain('model_context_window=272000')
  })

  it('新会话的 TUI argv 带上模型钉,且在 --remote 之前', () => {
    const session = new CodexAppServerSession('agent-pin', '/unused/codex')
    Object.assign(session as unknown as Record<string, unknown>, {
      awaitingTuiThread: true,
      cwd: '/w',
      endpoint: ENDPOINT,
      tuiModelSelectionArgs: codexTuiModelSelectionArgs(APP_SERVER_ARGS),
    })
    const args = session.remoteTuiArgs()
    expect(args).toEqual(expect.arrayContaining(['model="gpt-5.6-luna"', 'model_reasoning_effort="medium"']))
    expect(args.indexOf('model="gpt-5.6-luna"')).toBeLessThan(args.indexOf('--remote'))
  })

  it('resume 钉的是 thread 自己存的模型,❌ 不是这次 composer 的选择', () => {
    const session = new CodexAppServerSession('agent-resume-pin', '/unused/codex')
    Object.assign(session as unknown as Record<string, unknown>, {
      threadId: 'tid',
      endpoint: ENDPOINT,
      tuiModelSelectionArgs: codexTuiModelSelectionArgs(APP_SERVER_ARGS),
      tuiResumeArgs: codexTuiThreadSettingsArgs({ model: 'glm-5.3' }),
    })
    const args = session.remoteTuiArgs()
    expect(args).not.toContain('model="gpt-5.6-luna"')
    // 末尾的关自更新(#6186)不属于这一格,只看 `resume … <tid>` 这一段。
    expect(args.slice(args.indexOf('resume'), args.indexOf('tid') + 1)).toEqual(['resume', '-c', 'model="glm-5.3"', 'tid'])
  })
})

describe('#6264 终端会话的回合被登录失效拒掉 ⇒ 报给宿主(与聊天会话同一条判据)', () => {
  const completed = (error: unknown) => ({ method: 'turn/completed', params: { threadId: 't', turn: { status: 'failed', error } } })

  it('codexErrorInfo=unauthorized(d22 读数:refresh token 已失效)', () => {
    expect(codexTurnSignInRequired(completed({ message: 'Your access token could not be refreshed', codexErrorInfo: 'unauthorized' }))).toBe(true)
  })

  it('别的失败不算;没有 error 不算;不是 turn/completed 不算', () => {
    expect(codexTurnSignInRequired(completed({ message: 'boom', codexErrorInfo: 'other' }))).toBe(false)
    expect(codexTurnSignInRequired(completed(undefined))).toBe(false)
    expect(codexTurnSignInRequired({ method: 'turn/started', params: { threadId: 't', turn: { error: { codexErrorInfo: 'unauthorized' } } } })).toBe(false)
  })
})

describe('#6264 清掉探针以前漏进用户 codex 配置的信任条目', () => {
  // d22 实机那份 config.toml 的形状(路径照抄,别的键换成占位)。
  const D22 = [
    'model = "gpt-6-astra"',
    'model_reasoning_effort = "xhigh"',
    '[projects."/tmp/gugu-model-probe-codex-yT5ptu"]',
    'trust_level = "trusted"',
    '',
    '[projects."/www/projects/gugu"]',
    'trust_level = "trusted"',
    '',
    '[projects."/tmp/gugu-model-probe-codex-HziYP7"]',
    'trust_level = "trusted"',
    '',
    '[projects."/root/.config/咕咕/task-home"]',
    'trust_level = "trusted"',
    '',
    '[projects."/tmp/gugu-model-probe-codex-t8Guvb"]',
    'trust_level = "trusted"',
    '',
  ].join('\n')

  it('只摘探针目录那几段,其余逐字节不变', () => {
    const { text, removed } = stripGuguProbeTrustEntries(D22)
    expect(removed).toBe(3)
    expect(text).toBe([
      'model = "gpt-6-astra"',
      'model_reasoning_effort = "xhigh"',
      '',
      '[projects."/www/projects/gugu"]',
      'trust_level = "trusted"',
      '',
      '[projects."/root/.config/咕咕/task-home"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'))
  })

  it('再跑一次是空操作(原文原样返回)', () => {
    const once = stripGuguProbeTrustEntries(D22).text
    expect(stripGuguProbeTrustEntries(once)).toEqual({ text: once, removed: 0 })
  })

  it('macOS 的 tmpdir 路径、CRLF 换行照样认', () => {
    const mac = 'a = 1\r\n\r\n[projects."/private/var/folders/x/T/gugu-model-probe-codex-Ab12Cd"]\r\ntrust_level = "trusted"\r\n'
    expect(stripGuguProbeTrustEntries(mac)).toEqual({ text: 'a = 1\r\n', removed: 1 })
  })

  it('形状对不上一格就不动:多了别的键、用户加了注释、有子表、名字不是探针那种', () => {
    const cases = [
      '[projects."/tmp/gugu-model-probe-codex-AbC123"]\ntrust_level = "trusted"\nextra = 1\n',
      '[projects."/tmp/gugu-model-probe-codex-AbC123"]\n# mine\ntrust_level = "trusted"\n',
      '[projects."/tmp/gugu-model-probe-codex-AbC123"]\ntrust_level = "trusted"\n[projects."/tmp/gugu-model-probe-codex-AbC123".x]\ny = 1\n',
      '[projects."/tmp/gugu-model-probe-codex-AbC123"]\ntrust_level = "untrusted"\n',
      '[projects."/tmp/my-gugu-model-probe-codex-AbC123x"]\ntrust_level = "trusted"\n',
      '[projects."/tmp/gugu-model-probe-claude-AbC123"]\ntrust_level = "trusted"\n',
    ]
    for (const text of cases) expect(stripGuguProbeTrustEntries(text)).toEqual({ text, removed: 0 })
  })
})

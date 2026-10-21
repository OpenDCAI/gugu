import { describe, expect, it, vi } from 'vitest'
import { refreshSupabaseSession, RuntimeAuthError } from '@gugu/core'

vi.mock('@gugu/core/cloud/config', () => ({
  getSupabaseAnonKey: () => 'public-anon-key',
  getSupabaseUrl: () => 'https://db.example.test',
}))

import {
  ModelAccessHttpError,
  ModelAccessUnreachableError,
  listPlatformModels,
  modelAccessFailureReason,
} from '../../../../apps/desktop/electron/model-access'
import { platformCatalogFailureReason } from '../../../../apps/desktop/electron/sessionpage/sessionpage-platform-catalog'
import { platformAccessStartError } from '../../../../apps/desktop/electron/sessionpage/sessionpage-platform-model'

// #6264 d22 真机:测试库没配模型网关,model-access 回 503 `model access server is not configured`,
// 这句英文原样铺进了新建任务的工具栏。宿主只能报原因码,原文只进日志。
const NOT_CONFIGURED = new ModelAccessHttpError('model access server is not configured', 503)

// #7103 服务端原因表(product spec「被拒时谁说话」)的每一行 → 客户端说话用的原因。
// 服务端的 reason 只在 modelAccessFailureReason 一处认;表外的、不带 reason 的一律「咕咕这边出错了」。
describe('modelAccessFailureReason: 服务端原因表的每一行', () => {
  it.each([
    ['signed_out', 401, 'signed-out'],
    ['membership_required', 403, 'membership-required'],
    ['model_unavailable', 409, 'model-unavailable'],
    // 不出话的三种:客户端照表改走签发 / 当作已撤 / 重建身份;真走到这里就是「咕咕这边出错了」。
    ['session_not_found', 404, 'service-unavailable'],
    ['session_ended', 409, 'service-unavailable'],
    ['agent_not_owned', 403, 'service-unavailable'],
    ['bad_request', 400, 'service-unavailable'],
    // 不是 POST(405)、设置里关一个目录里没有的模型(404)也是 bad_request。
    ['bad_request', 405, 'service-unavailable'],
    ['bad_request', 404, 'service-unavailable'],
    // 只给运营 / 服务角色的动作:客户端不调,真走到这里也只是「咕咕这边出错了」。
    ['forbidden', 403, 'service-unavailable'],
    ['gateway_busy', 503, 'service-unavailable'],
    ['gateway_unreachable', 502, 'service-unavailable'],
    ['internal', 500, 'service-unavailable'],
  ] as const)('%s (%i) → %s', (reason, status, expected) => {
    expect(modelAccessFailureReason(new ModelAccessHttpError(`server says ${reason}`, status, reason))).toBe(expected)
  })

  it('认不出的原因、不带原因的 4xx 都说「咕咕这边出错了」,❌ 按状态码猜', () => {
    expect(modelAccessFailureReason(new ModelAccessHttpError('x', 403, 'some_new_reason'))).toBe('service-unavailable')
    // 以前 429 = 额度用完、其余 4xx = 换模型新开任务:都是猜的。
    expect(modelAccessFailureReason(new ModelAccessHttpError('quota exhausted', 429))).toBe('service-unavailable')
    expect(modelAccessFailureReason(new ModelAccessHttpError('model is not offered', 400))).toBe('service-unavailable')
    expect(modelAccessFailureReason(NOT_CONFIGURED)).toBe('service-unavailable')
    expect(modelAccessFailureReason(new Error('something else'))).toBe('service-unavailable')
    // 原型链上的键 ❌ 被当成原因。
    expect(modelAccessFailureReason(new ModelAccessHttpError('x', 403, 'constructor'))).toBe('service-unavailable')
  })

  it('401 不论带不带 reason 都是登录失效(JWT 坏了时边缘运行时先拦,回的是它自己的 {msg})', () => {
    expect(modelAccessFailureReason(new ModelAccessHttpError('Invalid JWT', 401))).toBe('signed-out')
  })

  it('本机认得出的两种:没登录、请求根本没发出去', () => {
    expect(modelAccessFailureReason(new RuntimeAuthError('model catalog requires authenticated Supabase runtime auth'))).toBe('signed-out')
    expect(modelAccessFailureReason(new ModelAccessUnreachableError(new TypeError('fetch failed')))).toBe('unreachable')
  })

  // 规格:停库 / 登录服务 5xx 时 ❌ 说成登录失效;只有登录服务明说这张票不认(400)才是。
  it('本机续登录票:登录服务 5xx 是「咕咕这边出错了」,明说不认才是登录失效', async () => {
    const refreshAnswering = (status: number) =>
      refreshSupabaseSession({
        supabaseUrl: 'https://db.example.test',
        anonKey: 'public-anon-key',
        refreshToken: 'refresh',
        fetchImpl: async () => new Response('{}', { status }),
      }).catch((error: unknown) => error)
    expect(modelAccessFailureReason(await refreshAnswering(503))).toBe('service-unavailable')
    expect(modelAccessFailureReason(await refreshAnswering(400))).toBe('signed-out')
  })
})

describe('model-access failure → reason code', () => {
  it('catalog: only a code reaches the composer, never the server text', () => {
    expect(platformCatalogFailureReason(NOT_CONFIGURED)).toBe('gugu-models:service-unavailable')
    expect(platformCatalogFailureReason(new Error('model catalog response is malformed'))).toBe('gugu-models:service-unavailable')
  })

  it('catalog: a request that never arrived is told apart from one that was refused', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const error = await listPlatformModels({ getAuth: async () => ({ accessToken: 'jwt', userId: 'u1' }) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelAccessUnreachableError)
    expect(platformCatalogFailureReason(error)).toBe('gugu-models:unreachable')
    fetchSpy.mockRestore()
  })

  it('session start: the thrown error carries only the code, the raw text only as cause', () => {
    const thrown = platformAccessStartError(NOT_CONFIGURED, { sessionId: 'c1', providerId: 'claude' })
    expect(thrown.message).toBe('gugu-models:service-unavailable')
    expect(thrown.cause).toBe(NOT_CONFIGURED)
    // #7103 认不出的(以前原样抛)也只报码:原文 ❌ 上屏。
    const quota = new ModelAccessHttpError('quota exhausted', 429)
    expect(platformAccessStartError(quota, { sessionId: 'c1', providerId: 'claude' }).message).toBe('gugu-models:service-unavailable')
    const devText = new Error('codex declares no model injection dialect (engine-injection-contract)')
    expect(platformAccessStartError(devText, { sessionId: 'c1', providerId: 'codex' }).message).toBe('gugu-models:service-unavailable')
  })

  // #7092 免费号首启一条会员模型的任务:网关回 403 membership_required。界面说「这个模型要开会员」,
  // ❌ 把 `ModelAccessHttpError: ...` 原文铺成「这个任务没能启动」。
  it('session start: a membership refusal is reported as a code, not as a broken task', () => {
    const refused = new ModelAccessHttpError('model glm-5.3 requires a membership', 403, 'membership_required')
    const thrown = platformAccessStartError(refused, { sessionId: 'c1', providerId: 'codex' })
    expect(thrown.message).toBe('gugu-models:membership-required')
    expect(thrown.cause).toBe(refused)
  })

  it('session start: a code thrown by this machine passes through unchanged', () => {
    const local = new Error('gugu-models:not-routable', { cause: new Error('grok consumes no credential that can be redirected') })
    expect(platformAccessStartError(local, { sessionId: 'c1', providerId: 'grok' })).toBe(local)
  })
})

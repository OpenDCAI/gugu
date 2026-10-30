/** Give a newly created task one short identity name after its first completed turn.
 * The existing model ticket, timeout and settlement flow is unchanged. Explicit names win;
 * unavailable or unusable automatic names leave the canonical serial placeholder in place.
 */
import * as electron from 'electron'
import type { RuntimeAuthProvider } from '@gugu/core'
import {
  issuePlatformModelAccess,
  modelAccessFailureReason,
  revokePlatformModelAccess,
  type IssuedModelAccess,
} from './model-access'
import { createLogger } from './lib/logger'
import {
  SESSION_TITLE_TIMEOUT_MS,
  parseGeneratedSessionTitle,
  sessionTitleRequestBody,
  shouldGenerateSessionTitle,
} from '../src/session/shared/core/sessions/session-title-namer'

const log = createLogger('session-title-namer')

/** 签票时报的「引擎」:不是哪个 harness,只是账本上认得出这张票是起名签的。 */
const SESSION_TITLE_ENGINE_ID = 'gugu-session-title'
const SESSION_TITLE_PROTOCOL = 'openai-chat-completions'

export type SessionTitleOutcome =
  | 'named'
  | 'superseded'
  | 'not-pending'
  | 'disabled'
  | 'not-fallback'
  | 'too-short'
  | 'signed-out'
  | 'refused'
  | 'timeout'
  | 'failed'
  | 'unusable'

export interface SessionTitleNamerDeps {
  authProvider: () => RuntimeAuthProvider | null
  /** 等这个 agent 的云端身份落地(签平台票要它);供给失败即抛。 */
  awaitAgentIdentity: (agentUserId: string) => Promise<void>
  /** 设置里选的起名模型(null = 关掉了)与追加的起名要求。 */
  titleSettings: () => Promise<{ model: string | null; instructions: string }>
  /** 这条会话的标题此刻是不是首轮兜底,以及它的首轮。 */
  titleState: (sessionId: string) => { fallback: boolean; firstUtterance: string | undefined; managed: boolean }
  /** 落名;返回 false = 这一刻已经有别的名(人改的 / harness 起的),不收。 */
  applyTitle: (sessionId: string, title: string) => boolean | Promise<boolean>
  now?: () => number
}

function netFetch(url: string, init: RequestInit): Promise<Response> {
  const fetcher = (electron as { net?: { fetch?: typeof fetch } } | undefined)?.net?.fetch
  return fetcher ? fetcher(url, init) : fetch(url, init)
}

/** 模型回的 content:字符串,或 [{type:'text', text}] 一串。 */
function contentText(payload: unknown): string | null {
  const content = (payload as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('')
  }
  return null
}

/** 网关替模型回的「不给」(gugu-speak 渠道的错误码):积分用完、这一档要会员。 */
const GATEWAY_REFUSAL_CODES = new Set(['credits_exhausted', 'membership_required'])

class Timeout extends Error {}

export function createSessionTitleNamer(deps: SessionTitleNamerDeps) {
  const now = deps.now ?? Date.now
  const running = new Set<string>()

  async function name(sessionId: string, agentUserId: string, startedAt: number): Promise<SessionTitleOutcome> {
    const { model, instructions } = await deps.titleSettings()
    if (!model) return 'disabled'
    const state = deps.titleState(sessionId)
    if (!state.fallback) return 'not-fallback'
    if (!shouldGenerateSessionTitle(state.firstUtterance)) return 'too-short'
    const authProvider = deps.authProvider()
    if (!authProvider) return 'signed-out'
    try {
      await deps.awaitAgentIdentity(agentUserId)
    } catch (error) {
      log.warn({ sessionId, agentUserId, err: error }, 'session title: the agent identity never landed, keeping the current title')
      return 'failed'
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Timeout()), SESSION_TITLE_TIMEOUT_MS)
    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Timeout()), { once: true })
    })
    // 每一处等待都与它赛跑、自己接住它的拒绝;这一条只是让「预算刚好在两处等待之间到」不变成未处理的拒绝。
    expired.catch(() => undefined)
    const issuing = issuePlatformModelAccess({
      authProvider,
      agentUserId,
      engineId: SESSION_TITLE_ENGINE_ID,
      modelId: model,
      protocol: SESSION_TITLE_PROTOCOL,
      sessionId,
    })
    let access: IssuedModelAccess | null = null
    try {
      try {
        access = await Promise.race([issuing, expired])
      } catch (error) {
        if (error instanceof Timeout) {
          // 票在预算之后才签回来:那张票没人用,签回来就结掉。
          void issuing.then((late) => revoke(authProvider, late)).catch(() => undefined)
          return 'timeout'
        }
        const reason = modelAccessFailureReason(error)
        log.info({ sessionId, model, reason, err: error }, 'session title: could not get a platform ticket, keeping the current title')
        return reason === 'signed-out' ? 'signed-out' : 'refused'
      }
      if (access.membershipLocked.includes(model) || access.membershipLocked.includes(access.model)) {
        log.info({ sessionId, model }, 'session title: the chosen model needs a membership on this account, keeping the current title')
        return 'refused'
      }

      let response: Response
      try {
        response = await Promise.race([
          netFetch(`${access.relayUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access.token}` },
            body: JSON.stringify(sessionTitleRequestBody(model, access.model, state.firstUtterance ?? '', instructions)),
            signal: controller.signal,
          }),
          expired,
        ])
      } catch (error) {
        if (error instanceof Timeout || controller.signal.aborted) return 'timeout'
        log.warn({ sessionId, model, err: error }, 'session title: the model request did not go through')
        return 'failed'
      }
      const payload = (await Promise.race([response.json(), expired]).catch((error: unknown) => {
        if (error instanceof Timeout) throw error
        return null
      })) as unknown
      if (!response.ok) {
        // 网关明说不给 = 与没积分一样安静:402 / 403,或咕咕替模型说话的那几个错误码(积分用完时实测回的是
        // 400 + `credits_exhausted`,「花不出去也照常签」的票就落在这一格)。别的状态是真故障。
        const code = (payload as { error?: { code?: unknown } } | null)?.error?.code
        if (response.status === 402 || response.status === 403 || (typeof code === 'string' && GATEWAY_REFUSAL_CODES.has(code))) {
          log.info({ sessionId, model, status: response.status, code }, 'session title: the gateway refused, keeping the current title')
          return 'refused'
        }
        log.warn({ sessionId, model, status: response.status }, 'session title: the model request failed')
        return 'failed'
      }
      const title = parseGeneratedSessionTitle(contentText(payload) ?? '')
      if (!title) {
        log.warn({ sessionId, model, contentLength: contentText(payload)?.length ?? null }, 'session title: the model did not return a usable name')
        return 'unusable'
      }
      const applied = await deps.applyTitle(sessionId, title)
      log.info({ sessionId, model, applied, elapsedMs: now() - startedAt }, 'session title: generated')
      return applied ? 'named' : 'superseded'
    } catch (error) {
      if (error instanceof Timeout) return 'timeout'
      throw error
    } finally {
      clearTimeout(timer)
      if (access) void revoke(authProvider, access)
    }
  }

  async function revoke(authProvider: RuntimeAuthProvider, access: IssuedModelAccess): Promise<void> {
    await revokePlatformModelAccess(authProvider, access.accessSessionId).catch((error: unknown) => {
      log.warn({ err: error, accessSessionId: access.accessSessionId }, 'session title: ticket not settled; the ledger settles it on exit')
    })
  }

  return {
    /** The host calls after the first completed turn, when the identity is available. */
    async firstTurnCompleted(sessionId: string, agentUserId: string): Promise<SessionTitleOutcome> {
      const state = deps.titleState(sessionId)
      if (!state.managed || running.has(sessionId)) return 'not-pending'
      if (!state.fallback) return 'not-fallback'
      running.add(sessionId)
      try {
        const outcome = await name(sessionId, agentUserId, now())
        if (outcome === 'timeout') log.info({ sessionId, budgetMs: SESSION_TITLE_TIMEOUT_MS }, 'session title: no name within budget, keeping the current title')
        return outcome
      } finally { running.delete(sessionId) }
    },
  }
}

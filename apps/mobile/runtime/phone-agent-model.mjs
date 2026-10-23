const protocol = 'openai-chat-completions'
const required = (value, field) => { if (typeof value !== 'string' || !value) throw new Error(`model-access response has no ${field}`); return value }

export function createPhoneModelAccess(cloud, store, warn) {
  const catalog = async (includeHidden = false) => {
    const result = await cloud.modelAccess({ action: 'catalog' })
    if (!Array.isArray(result.models)) throw new Error('platform model catalog is malformed')
    return result.models.filter((model) => model.enabled && (includeHidden || !model.hidden) && model.protocols?.includes(protocol))
  }
  const resolve = async (requested) => {
    const models = await catalog(true)
    if (requested && !requested.startsWith('platform:')) throw new Error('手机宿主当前只支持咕咕平台模型，请传 session_list_models 返回的 platform: 模型编号')
    const id = requested?.slice('platform:'.length)
    const found = id ? models.find((item) => item.id === id) : models.find((item) => !item.requires_membership)
    if (!found) throw new Error(id ? `手机 Agent 不支持平台模型 ${id}` : '没有可供手机 Agent 使用的平台模型')
    return found.id
  }
  const settle = async (id) => {
    await cloud.modelAccess({ action: 'revoke', session_id: id })
    delete store.state.leases[id]
    await store.save()
  }
  return {
    catalog, resolve,
    async recover() {
      for (const id of Object.keys(store.state.leases)) {
        try { await settle(id) } catch (error) { warn(`平台模型旧票结清失败: ${error.message}`) }
      }
    },
    async issue(agent, { onExpired = () => undefined } = {}) {
      const access = await cloud.modelAccess({ action: 'issue', agent_user_id: agent.agentUserId, engine_id: 'pi', model_id: agent.modelId, protocol, provider_session_id: agent.sessionId })
      const id = required(access.session_id, 'session_id')
      store.state.leases[id] = { agentUserId: agent.agentUserId, sessionId: agent.sessionId, issuedAt: new Date().toISOString() }
      try { await store.save() } catch (error) { await cloud.modelAccess({ action: 'revoke', session_id: id }); throw error }
      let model
      let expiresAt
      try {
        if (access.protocol !== protocol) throw new Error('平台模型返回了手机 Agent 不支持的协议')
        const relayUrl = required(access.relay_url, 'relay_url').replace(/\/$/, '')
        const apiKey = required(access.token, 'token')
        // The issuer returns the relay root (which may have a /gateway prefix), while
        // OpenAI SDKs require the protocol's /v1 base, exactly as on desktop.
        const { OPENAI_BASE_URL: baseUrl } = platformModelAccessEnv(protocol, relayUrl, apiKey)
        model = { baseUrl, apiKey, model: required(access.model, 'model'), contextWindow: access.context_window ?? undefined }
        if (new URL(model.baseUrl).protocol !== 'https:') throw new Error('平台模型地址必须使用 HTTPS')
        expiresAt = Date.parse(required(access.expires_at, 'expires_at'))
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('平台模型票据有效期无效')
      } catch (error) { await settle(id); throw error }
      let stopped = false
      let timer = null
      let renewal = Promise.resolve()
      const renew = () => {
        renewal = cloud.modelAccess({ action: 'renew', session_id: id }).then((next) => {
          const nextExpiry = Date.parse(required(next.expires_at, 'expires_at'))
          if (!Number.isFinite(nextExpiry) || nextExpiry <= Date.now()) throw new Error('平台模型续期有效期无效')
          expiresAt = nextExpiry
          if (!stopped) arm()
        }).catch((error) => {
          warn(`平台模型续期失败: ${error.message}`)
          if (stopped) return
          const remaining = expiresAt - Date.now()
          if (remaining <= 0) { onExpired(error); return }
          timer = setTimeout(() => { if (expiresAt <= Date.now()) onExpired(error); else renew() }, Math.min(15_000, remaining))
        })
      }
      const arm = () => { timer = setTimeout(renew, Math.max(1_000, expiresAt - Date.now() - 120_000)) }
      arm()
      return {
        model,
        async close() {
          stopped = true; clearTimeout(timer); await renewal
          try { await cloud.modelAccess({ action: 'checkpoint', session_id: id }) } finally { await settle(id) }
        },
      }
    },
  }
}
import { platformModelAccessEnv } from '../../../packages/core/src/local/agent/modelAccess.ts'

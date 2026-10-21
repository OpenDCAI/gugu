import { parseMachineLimitRefusal, type MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { edgeFunctionError } from '../../lib/edgeFunctionError'
import { dataClient } from '../../lib/supabase'

/**
 * 咕咕 App 里批准一台跑了 `gugu-server login` 的机器:以 App 自己的登录调 server-login 的 view / decide
 * (nmhjklnm/gugu-supabase supabase/functions/server-login),批准与网页确认页是同一个(approveAs),只是不再要邮箱验证码。
 */
export type ServerLoginState = 'pending' | 'approved' | 'denied' | 'refused' | 'expired'

export type ServerLoginRequest = {
  code: string
  state: ServerLoginState
  machine: { hostname: string | null; platform: string | null; arch: string | null; user: string | null }
  requesterIp: string | null
}

export type ServerLoginDecision = { state: ServerLoginState; refusal: MachineLimitRefusal | null }

type Invoked = { data: unknown; error: Error | null }

/** 函数名在调用点写成字面量:发版前的契约门(scripts/release-contract-gate)按字面量核目标库部署了哪些函数。 */
async function answer(invoked: Promise<Invoked>): Promise<Record<string, unknown>> {
  const { data, error } = await invoked
  if (error) throw new Error(await edgeFunctionError(error))
  return data as Record<string, unknown>
}

export async function readServerLoginRequest(code: string): Promise<ServerLoginRequest> {
  const data = await answer(dataClient.functions.invoke('server-login/view', { body: { code } }))
  const machine = (data.machine ?? {}) as ServerLoginRequest['machine']
  return {
    code: String(data.code),
    state: data.state as ServerLoginState,
    machine,
    requesterIp: typeof data.requester_ip === 'string' ? data.requester_ip : null,
  }
}

export async function decideServerLogin(code: string, approve: boolean): Promise<ServerLoginDecision> {
  const data = await answer(dataClient.functions.invoke('server-login/decide', { body: { code, approve } }))
  return { state: data.state as ServerLoginState, refusal: parseMachineLimitRefusal(data.refusal) }
}

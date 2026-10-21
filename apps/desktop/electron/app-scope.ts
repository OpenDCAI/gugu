import { appsGivenTo } from '../src/session/shared/extensions/app-enablements-core'
import { HERE_ALL } from '../src/session/shared/extensions/host-actions'
import { awaitSessionpageCloudIdentity } from './sessionpage/emdash-agent-provisioning'

/**
 * D-30 (主人 10-06「肯定是能选的啊」, on 主人 10-01 / 10-02): the Apps (`<publisher>/<id>`) whose tools this agent's owner gave
 * at a chat it is in — a group of theirs, or its own private chat with them (`chat.app_enablements`). Read whenever it is
 * asked (编号 4, 10-12: a chat given while the session runs counts from its next call, as this computer's places always did);
 * never blocks the opening (#5331). A new agent's chats are there once its cloud identity has landed, so the first read sees them.
 */
export async function appScopeOf(
  agentUserId: string,
  auth: () => Promise<{ accessToken: string; userId: string }>,
): Promise<ReadonlySet<string>> {
  await awaitSessionpageCloudIdentity(agentUserId).catch(() => undefined)
  const { accessToken, userId } = await auth()
  return appsGivenTo(accessToken, userId, agentUserId)
}

/**
 * Whether an App's tools reach a session: this computer's places (`here`, kept with the install) — every agent (also when
 * nobody chose, `null`: 125 10-06) — else a chat its owner gave it at (`scope`, read now, and only when this computer's
 * places do not already give it).
 */
export async function inAppScope(
  here: readonly string[] | null,
  app: string | null,
  scope: () => Promise<ReadonlySet<string>>,
): Promise<boolean> {
  if (here === null || here.includes(HERE_ALL)) return true
  return app !== null && (await scope()).has(app)
}

import { getPlugin } from '@main/core/agents/plugin-registry';
import type { Session } from '@shared/core/sessions/sessions';
import { resolveAgentSessionCommandArgs } from './resolve-agent-session-command';

/**
 * 终端腿停掉再起,会不会接回**原来那条**对话。闲置回收只停接得回来的(spec idle-reclaim)。
 *
 * 按这一家声明的 `sessions.tuiResume`,用真实 spawn 同一个解析(`resolveAgentSessionCommandArgs`)判:
 * - `caller-id`:续跑 argv 里的 id 是咕咕解析出来的那个,它必须就是库里记着的 `session_id`
 *   (分叉出来、id 由引擎另铸却没标 `providerMintedSessionId` 的会话,这里对不上 ⇒ 不算);
 * - `provider-id`:库里得记着它自己报回来的原生 id(≠ 会话 id),且过得了这一家的 id 校验 ——
 *   否则 argv 会退到按 cwd 猜最近一条,或干脆新开。
 * 没声明 = 续不回指定的那一条。
 */
export function tuiResumesExactly(session: Session): boolean {
  const plugin = getPlugin(session.providerId);
  const mode = plugin.capabilities.sessions.tuiResume;
  const stored = session.providerSessionId;
  if (!mode || !stored) return false;
  if (mode === 'caller-id') {
    const resolved = resolveAgentSessionCommandArgs(session, true);
    return resolved.isResuming && resolved.cliSessionId === stored;
  }
  if (stored === session.id) return false;
  const validate = plugin.behavior.sessions?.validateProviderSessionId;
  return validate ? validate(stored) : true;
}

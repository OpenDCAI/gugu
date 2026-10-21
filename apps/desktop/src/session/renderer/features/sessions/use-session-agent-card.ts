import { useEffect, useState } from 'react';
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import { findSessionShellPort, isSessionShellUnsupported, onSessionpageIdentityEvent } from '@renderer/lib/shell-port';
import { log } from '@renderer/utils/logger';
import type { SessionShellAgentCard as AgentCard } from '@shared/lib/ipc/shell-port';

/**
 * 这条会话的 agent 名片(咕咕身份):null = 还没有身份(还没 provision 完、非会话页 provider、网页版壳不提供)。
 * 分享入口与模式按钮的「聊天」读同一份 —— 有身份才有私聊可去。
 *
 *  · 键是 **conversationId**:一个 task 里 N 条会话 N 个 agent(spawn 出来的子会话与父会话同属一个 task),
 *    按 task 认领会把任意一条会话的身份挂上来 —— 实测看着主会话,按钮却写着子会话的名字、点开又是主会话的名片。
 *  · 会话切换即重查:头部是常驻浮层,不跟着 conversationId 变就会拿着上一条会话的 agent(错人)。
 */
export function useSessionAgentCard(sessionId: string | undefined): AgentCard | null {
  const [card, setCard] = useState<AgentCard | null>(null);

  useEffect(() => {
    let cancelled = false;
    const shell = findSessionShellPort();
    if (!sessionId || !shell) {
      setCard(null);
      return;
    }
    void shell
      .agentCard(sessionId)
      .then((next) => {
        if (!cancelled) setCard(next);
      })
      .catch((error: unknown) => {
        // 这个形态的壳明确不提供会话身份(#5012 网页版)= 已知状态,入口置灰即可,不是故障。
        if (isSessionShellUnsupported(error)) {
          if (!cancelled) setCard(null);
          return;
        }
        // 查不到身份就按「还没有身份」呈现(点击时宿主会说明原因),但不许静默:否则一个查询故障
        // 看起来和「这条会话真的还没 provision」一模一样,没法区分。
        // ❌ 不进翻译目录：这是写给开发者的日志，不是产品文案。
        log.error('[sessionpage] 查会话的 agent 名片失败,按「无身份」呈现', error);
        if (!cancelled) setCard(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // The contacts/chat surface publishes identity.users updates through the shared bridge. Keep the
  // card on that same canonical name when another device renames this agent while the task is open.
  useEffect(() => {
    const bridge = readIdentityDirectoryBridge();
    if (!sessionId || !bridge) return;
    return bridge.subscribe(() => {
      const identities = bridge.getSnapshot();
      if (!identities) return;
      setCard((current) => {
        if (!current) return current;
        const canonical = identities[current.agentUserId]?.display_name?.trim();
        return canonical && canonical !== current.displayName
          ? { ...current, displayName: canonical }
          : current;
      });
    });
  }, [sessionId]);

  // 身份是会话启动后才到位的,所以刚创建的会话第一次查必然是 null。main 在 provisioning 落地时会播一次,
  // 这里只认领**属于这条会话**的那条 —— 入口当场变可用,不必等用户切换会话(❌ 轮询自愈)。
  // @@@share-card-rename 改名也播一条:名字是开会话时查一次存下来的,不听这条,用户在分享卡片里
  // 改完名,按钮的提示还挂着旧名 —— 同一个 agent 两个名字,只不过这次差在缓存里。
  // 两条事件的载荷同形、认领判据同一条(必须是**这条会话**),所以共用一个处理器。
  // #6264 别的机器上的会话由那台机器推,与本机合流(onSessionpageIdentityEvent)。
  useEffect(() => {
    if (!sessionId) return;
    return onSessionpageIdentityEvent((event) => {
      if (event.conversationId !== sessionId) return;
      setCard({ agentUserId: event.agentUserId, displayName: event.displayName });
    });
  }, [sessionId]);

  return card;
}

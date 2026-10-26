import type { ContextMentionProvider, MentionItem } from '@gugu/session-ui/react/components';
import { AT_BARE_PATTERN } from '@gugu/session-shared/markdown';
import type { LocalAgentCreationTool } from '@/lib/agentCreationTools';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { formatSessionTitleForDisplay } from '@renderer/features/sessions/session-title-utils';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { shellPort } from '@renderer/lib/shell-port';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { SESSION_PRIVATE_AGENT_ERROR, type SessionShellPeer } from '@shared/lib/ipc/shell-port';
import {
  registerLocalSessionMentions,
  type LocalSessionMention,
} from './chat-mention-provider';
import { resolveSessionDisplayName } from '@shared/core/sessions/session-display-name';
import { log } from '@renderer/utils/logger';

type MentionCandidate = LocalSessionMention & { number: string; sessionId?: string };

type MentionTool = Pick<LocalAgentCreationTool, 'icon'>;

export type LocalSessionMentionOptions = {
  excludeSessionId?: string;
  creationToolsByEngine?: ReadonlyMap<string, MentionTool>;
};

/**
 * Find a peer conversation like the sidebar does: a mounted one by its store; one on another machine that is not
 * mounted by its row in the session directory (listing never mounts).
 */
function findSessionForMention(
  sessionId: string
): { agentDisplayName?: string | null; providerId: string; title: string } | undefined {
  for (const project of getProjectManagerStore().projects.values()) {
    const sessions = project.mountedProject?.sessionManager?.sessions;
    if (!sessions) continue;
    for (const page of sessions.values()) {
      const session = sessionRegistry.get(page.data.id)?.sessions.get(sessionId);
      if (session) return session.data;
    }
  }
  const listed = remoteHostsStore.findListedSession(sessionId);
  return listed ? { providerId: listed.harness, title: listed.title } : undefined;
}

function candidatesFromRows(
  rows: readonly SessionShellPeer[],
  options: LocalSessionMentionOptions,
): MentionCandidate[] {
  return rows.flatMap((peer) => {
    if (peer.sessionId === options.excludeSessionId) return [];
    const users = peer.identity.users;
    const session = findSessionForMention(peer.sessionId);
    const name = resolveSessionDisplayName({
      identityName: users.display_name,
      explicitName: session?.agentDisplayName,
      providerId: session?.providerId,
      title: session?.title,
    });
    if (!name) return [];

    const engine = peer.engine;
    const iconUrl = engine ? options.creationToolsByEngine?.get(engine)?.icon?.trim() || '' : '';
    return [{
      id: users.id,
      sessionId: peer.sessionId,
      name,
      number: users.gugu_number == null ? '' : String(users.gugu_number),
      title: session
        ? formatSessionTitleForDisplay(session.providerId, session.title).trim() || undefined
        : undefined,
      engine: engine || undefined,
      iconUrl: iconUrl || undefined,
    }];
  });
}

function mentionItemsFromLocalSessionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): MentionItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  return candidates
    .filter((candidate) =>
      [candidate.name, candidate.number, candidate.title ?? ''].some((value) =>
        value.toLowerCase().includes(normalizedQuery),
      ),
    )
    .map((candidate) => ({
      // `aid:` = 界面上那一栏的名字(分享浮层写着 **Agent ID**),owner 2026-09-16 拍板。
      // 发出去的文本是 `@[Claude 1](aid:<Agent ID>)` —— 人看名字,机器拿 Agent ID。
      id: `aid:${candidate.id}`,
      label: `aid:${candidate.id}`,
      name: candidate.name,
      kind: 'custom' as const,
      role: 'agent' as const,
      engine: candidate.engine,
      description: candidate.title,
    }));
}

/** Keep local-session identity facts beside the startup queue's user-authored text. */
export function localSessionMentionHiddenContext(
  text: string,
  items: readonly MentionItem[],
): string | undefined {
  const byLabel = new Map(items.map((item) => [item.label, item]));
  // 两种写法都要认:现在写出去的是 `@[Claude 1](aid:<Agent ID>)`,2026-09-16 之前是裸的
  // `@user:<id>` —— 排队里可能还压着那种,老会话重开也会读到。
  const bracketTokens = [...text.matchAll(/@\[[^\]]*\]\(<?((?:aid|user):[^\s)>]+)>?\)/g)]
    .map((match) => match[1]);
  const bareTokens = [...text.matchAll(new RegExp(AT_BARE_PATTERN, 'g'))]
    .map((match) => match[1])
    .filter((token): token is string => token?.startsWith('user:') === true);
  const tokens = [...bracketTokens, ...bareTokens].filter(
    (token): token is string => typeof token === 'string'
  );
  const seen = new Set<string>();
  const facts = tokens.flatMap((token) => {
    // 去重按**归一之后**的地址算:同一条会话可能在一段话里既以新写法出现、又以旧的
    // `@user:<id>` 出现(排队里压着旧的、又新拖了一次)。按原样去重会把同一个 agent
    // 的身份事实写两遍。
    const canonical = token.replace(/^user:/, 'aid:');
    if (seen.has(canonical)) return [];
    seen.add(canonical);
    const item = byLabel.get(canonical) ?? byLabel.get(token);
    if (!item || item.kind !== 'custom' || item.role !== 'agent') return [];
    return `${JSON.stringify(`@${item.name ?? canonical}`)} = ${canonical} (agent)`;
  });
  return facts.length > 0 ? facts.join('\n') : undefined;
}

/**
 * 本机的名册(问本机宿主)加上别的机器上的(读会话目录),❌ 逐台去问:掉线又回来的那台会让弹层卡到超时(#7016)。
 * `notRead` = 在线却还没读到会话列表的机器,弹层为它们各说一行「没读到」,❌ 拿空列表冒充「那边没有」。
 */
async function loadLocalSessionMentionCandidates(
  options: LocalSessionMentionOptions & { mentionUri?: string } = {},
  sessionId?: string,
): Promise<{ candidates: MentionCandidate[]; notRead: readonly { id: string; label: string }[] }> {
  const local = await shellPort().sessionPeers(sessionId);
  const remote = remoteHostsStore.directoryPeers();
  const candidates = candidatesFromRows([...local, ...remote.peers], options);
  if (options.mentionUri) {
    registerLocalSessionMentions(options.mentionUri, candidates);
  }
  return { candidates, notRead: remote.notRead };
}

/** 没读到会话列表的那台机器:弹层里的一行说明,点不了、方向键跳过,❌ 写进消息。 */
function notReadItem(machine: { id: string; label: string }): MentionItem {
  return {
    id: `not-read:${machine.id}`,
    label: '',
    name: translateSessionMessage('remoteHost.mention.notRead', { device: machine.label }),
    kind: 'custom',
    disabled: true,
  };
}

export type LocalSessionMentionProvider = ContextMentionProvider & {
  /**
   * 侧栏上的一条会话行 → 与 @ 弹层里完全同一枚条目(把会话行拖进 composer 时走这条)。
   *
   * 名册里没有它 = 这条会话还没有咕咕身份(从没被驱动过,或这家引擎还没接通),此时返回 null:
   * 没有 `user:<uuid>` 就没有可投递的地址,❌ 不许拿标题拼一枚看着像、发不出去的 pill。
   */
  resolveSession(sessionId: string): Promise<MentionItem | null>;
};

export function createLocalSessionMentionProvider(
  options: LocalSessionMentionOptions & { mentionUri?: string } = {},
): LocalSessionMentionProvider {
  return {
    async search(query) {
      try {
        const { candidates, notRead } = await loadLocalSessionMentionCandidates(options);
        return [...mentionItemsFromLocalSessionCandidates(candidates, query), ...notRead.map(notReadItem)];
      } catch (error) {
        log.warn('Failed to load local session mentions', { error });
        return [];
      }
    },
    async resolveSession(sessionId) {
      const wanted = sessionId.trim();
      if (!wanted) return null;
      try {
        const { candidates } = await loadLocalSessionMentionCandidates(options, wanted);
        const match = candidates.find((candidate) => candidate.sessionId === wanted);
        if (!match) return null;
        // 空查询走与弹层同一条映射,pill 的形状(名字/图标/副标题)因此不会分叉。
        return mentionItemsFromLocalSessionCandidates([match], '')[0] ?? null;
      } catch (error) {
        log.warn('Failed to resolve dragged session mention', { error });
        if (error instanceof Error && error.message.includes(SESSION_PRIVATE_AGENT_ERROR)) {
          return { id: `private:${wanted}`, label: '', kind: 'custom', disabled: true,
            description: translateSessionMessage('chat.mentionDropPrivateAgent') };
        }
        return null;
      }
    },
  };
}

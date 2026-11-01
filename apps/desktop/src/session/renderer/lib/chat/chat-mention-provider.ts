import type { ChatMentionMeta, MentionProvider } from '@gugu/session-chat-ui';
import type { AgentIconAsset } from '@shared/core/agents/agent-payload';
import type { IssueProviderType } from '@shared/issue-providers';
import { pickIconVariant } from '../components/agent-icon-variant';
import { workspaceFileMentionProvider } from './workspace-file-mention-provider';

type IntegrationIconInput = {
  id: string;
  icon?: AgentIconAsset;
  features?: string[];
};

export type IssueMentionTarget = {
  token: string;
  provider: IssueProviderType;
  identifier: string;
};

const issueProviderIconUrls = new Map<string, string>();
const localSessionMentionsByUri = new Map<string, Map<string, ChatMentionMeta>>();

export type LocalSessionMention = {
  id: string;
  name: string;
  engine?: string;
  iconUrl?: string;
};

/** Replace the live peer snapshot for one task conversation used by transcript parsing. */
export function registerLocalSessionMentions(
  uri: string,
  mentions: readonly LocalSessionMention[],
): void {
  const byToken = new Map<string, ChatMentionMeta>();
  for (const mention of mentions) {
    const id = mention.id.trim().replace(/^(?:aid|user):/, '');
    const name = mention.name.trim();
    if (!id || !name) continue;
    const token = `aid:${id}`;
    const meta: ChatMentionMeta = {
      id: token,
      label: token,
      name,
      kind: 'custom',
      engine: mention.engine?.trim() || undefined,
      iconUrl: mention.iconUrl?.trim() || undefined,
    };
    byToken.set(token, meta);
    // 旧拼法一并登记:`aid:` 是 2026-09-16 才改的名字,在那之前发出去的消息里写的是
    // `@user:<id>`,它们仍在聊天记录里。不登记的话那些老消息的 pill 当场退化成裸文本。
    byToken.set(`user:${id}`, meta);
  }
  localSessionMentionsByUri.set(uri, byToken);
}

export function clearLocalSessionMentions(uri: string): void {
  localSessionMentionsByUri.delete(uri);
}

export function issueMentionToken(provider: IssueProviderType, identifier: string): string {
  return `issue:${provider}:${identifier}`;
}

export function parseIssueMentionToken(token: string): IssueMentionTarget | null {
  if (!token.startsWith('issue:')) return null;
  const rest = token.slice('issue:'.length);
  const providerEnd = rest.indexOf(':');
  if (providerEnd <= 0) return null;
  const provider = rest.slice(0, providerEnd) as IssueProviderType;
  const identifier = rest.slice(providerEnd + 1);
  if (!identifier) return null;
  return { token, provider, identifier };
}

export function registerIssueMentionIcons(integrations: IntegrationIconInput[]): void {
  issueProviderIconUrls.clear();
  for (const integration of integrations) {
    if (!integration.features?.includes('issues') || !integration.icon) continue;
    const url = iconAssetToUrl(integration.id, integration.icon);
    if (url) issueProviderIconUrls.set(integration.id, url);
  }
}

function iconAssetToUrl(id: string, icon: AgentIconAsset): string | null {
  const variant = pickIconVariant(icon.variants, 16);
  const content = variant.light;
  if (!content) return null;
  if (icon.kind === 'image') return content;

  return `data:image/svg+xml;charset=utf-8,${encodeSvgDataUrl(content, id)}`;
}

function encodeSvgDataUrl(svg: string, id: string): string {
  return encodeURIComponent(
    svg.replace(/<svg\b(?![^>]*\brole=)/, `<svg role="img" aria-label="${id}"`)
  );
}

class ChatMentionProvider implements MentionProvider {
  resolve(token: string, uri?: string): ChatMentionMeta | null {
    const issue = parseIssueMentionToken(token);
    if (issue) {
      return {
        id: issue.token,
        label: issue.token,
        name: issue.identifier,
        kind: 'issue',
        iconUrl: issueProviderIconUrls.get(issue.provider),
      };
    }

    const localSessionMention = uri ? localSessionMentionsByUri.get(uri)?.get(token) : undefined;
    if (localSessionMention) return localSessionMention;

    return workspaceFileMentionProvider.resolve(token);
  }
}

export const chatMentionProvider = new ChatMentionProvider();

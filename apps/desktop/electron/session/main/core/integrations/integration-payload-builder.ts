import {
  integrationPluginRegistry,
  type IntegrationAuthDescriptor,
  type LocalizedText,
} from '@gugu/session-plugins/integrations';
import { issuesPluginRegistry } from '@gugu/session-plugins/issues';
import type { IssueProviderCapabilities } from '@shared/issue-providers';

function issueCapabilities(integrationId: string): IssueProviderCapabilities {
  const plugin = issuesPluginRegistry.get(integrationId);
  const requiredInputs = plugin?.capabilities.issues.requiredInputs ?? [];
  return {
    requiresRepositoryUrl: requiredInputs.includes('repositoryUrl'),
    supportsIssueContext: !!plugin?.behavior.issues?.getIssue,
  };
}

function features(integrationId: string): string[] {
  const tags = issuesPluginRegistry.get(integrationId) ? ['issues'] : [];
  // GitHub's PR/repository support has no plugin type yet; keep the tags as a
  // documented exception until those capabilities exist.
  if (integrationId === 'github') tags.push('pullRequests', 'repositories');
  return tags;
}

/** Lowercase the leading letter unless the label starts with an acronym. */
function sentenceCase(label: string): string {
  if (label.length >= 2 && label[1] === label[1]?.toUpperCase()) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * 插件带的中英两份(`LocalizedText`)在这里按请求方的界面语言解析成一句话:线上的清单只有字符串这一种形状。
 * 老桌面把这几格直接当文本画(对象会让 React 整页抛错),也不传 locale ⇒ 拿到 en,与从前一样;
 * 新桌面传自己的界面语言。没给 / 不认的语言 = en。
 */
function pick(text: LocalizedText, locale: string | undefined): string {
  return locale === 'zh-CN' ? text['zh-CN'] : text.en;
}

type AuthMethod = IntegrationAuthDescriptor['methods'][number];

/** #921 凭据在哪保管:平台;这个安装没有这项平台服务时是这台电脑(连接页按它说)。 */
export type CustodyOf = (integrationId: string) => 'platform' | 'local' | null;

function localizedForm(
  { fields, help, custody, mcp: _localFallback, ...method }: Extract<AuthMethod, { kind: 'form' }>,
  locale: string | undefined,
  custodyHere: 'platform' | 'local' | undefined
) {
  return {
    ...method,
    // 对方的地址只给主进程用(本机保管时它自己拼),❌ 发给界面。
    ...(custody ? { custody: custodyHere ?? custody } : {}),
    fields: fields.map(({ label, placeholder, ...field }) => ({
      ...field,
      label: pick(label, locale),
      ...(placeholder ? { placeholder: pick(placeholder, locale) } : {}),
    })),
    ...(help ? { help: pick(help, locale) } : {}),
  };
}

function localizedCli({ prerequisite, ...method }: Extract<AuthMethod, { kind: 'cli' }>, locale: string | undefined) {
  return {
    ...method,
    ...(prerequisite
      ? { prerequisite: { text: pick(prerequisite.text, locale), ...(prerequisite.url ? { url: prerequisite.url } : {}) } }
      : {}),
  };
}

function localizedAuth(auth: IntegrationAuthDescriptor, locale: string | undefined, custodyHere: 'platform' | 'local' | undefined) {
  return {
    ...auth,
    methods: auth.methods.map((method) =>
      method.kind === 'form'
        ? localizedForm(method, locale, custodyHere)
        : method.kind === 'cli'
          ? localizedCli(method, locale)
          : method
    ),
  };
}

/**
 * Label for the disconnect confirmation ("This will delete the saved
 * <name> <label>..."). A single required form field names exactly what gets
 * deleted; multi-field forms fall back to "credentials".
 */
function disconnectCredentialLabel(auth: IntegrationAuthDescriptor, locale: string | undefined): string | undefined {
  const form = auth.methods.find((method) => method.kind === 'form');
  if (!form || form.kind !== 'form') return undefined;
  const requiredFields = form.fields.filter((field) => field.required);
  if (requiredFields.length === 1 && requiredFields[0]) {
    const { label } = requiredFields[0];
    return pick({ en: sentenceCase(label.en), 'zh-CN': label['zh-CN'] }, locale);
  }
  return pick({ en: 'credentials', 'zh-CN': '凭据' }, locale);
}

export function buildIntegrationListPayload(locale?: string, custodyOf?: CustodyOf) {
  return integrationPluginRegistry.getAll().map((plugin) => ({
    id: plugin.metadata.id,
    name: plugin.metadata.name,
    description: pick(plugin.metadata.description, locale),
    websiteUrl: plugin.metadata.websiteUrl,
    features: features(plugin.metadata.id),
    disconnectCredentialLabel: disconnectCredentialLabel(plugin.capabilities.auth, locale),
    capabilities: issueCapabilities(plugin.metadata.id),
    auth: localizedAuth(plugin.capabilities.auth, locale, custodyOf?.(plugin.metadata.id) ?? undefined),
    icon: plugin.assets.icon,
    // #7240 资源库详情的「能力」「推荐玩法」;老桌面不读这几格,不碍事。
    abilities: (plugin.metadata.abilities ?? []).map((ability) => pick(ability, locale)),
    playbooks: (plugin.metadata.playbooks ?? []).map((playbook) => ({
      title: pick(playbook.title, locale),
      prompt: pick(playbook.prompt, locale),
    })),
    multiAccount: plugin.metadata.multiAccount ?? false,
  }));
}

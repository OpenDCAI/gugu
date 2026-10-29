import type { IntegrationError } from '@gugu/session-plugins/integrations';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { IssueProviderType } from '@shared/issue-providers';
import type { IntegrationMetadata } from './integrations-provider';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

// @@@stable feature → label — 只有这三个已知能力有展示外壳;未知 feature 由调用方原样显示。
export function issueFeatureLabels(translate: Translate): Record<string, string> {
  return {
    issues: translate('integrations.featureIssues'),
    pullRequests: translate('integrations.featurePullRequests'),
    repositories: translate('integrations.featureRepositories'),
  };
}

export function isIssueIntegration(
  integration: IntegrationMetadata
): integration is IntegrationMetadata & { id: IssueProviderType } {
  return integration.features.includes('issues');
}

export function formatIntegrationId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getIntegrationName(
  integrationById: Partial<Record<string, IntegrationMetadata>>,
  provider: string
): string {
  return integrationById[provider]?.name ?? formatIntegrationId(provider);
}

/**
 * 那一家报的失败,按界面语言说。类型是那一家分好的(`toIntegrationError`,一组封闭的值);
 * `generic` 与认不出的类型照那一家的原话 —— ❌ 按原话的字面猜类型。
 */
export function integrationErrorText(
  translate: Translate,
  name: string,
  failure: { error?: string; errorType?: IntegrationError['type'] }
): string | undefined {
  const key = failure.errorType ? INTEGRATION_ERROR_KEYS[failure.errorType] : null;
  return key ? translate(key, { name }) : failure.error;
}

const INTEGRATION_ERROR_KEYS = {
  auth_failed: 'integrations.errorAuthFailed',
  authorization_expired: 'integrations.errorAuthorizationExpired',
  rate_limited: 'integrations.errorRateLimited',
  not_found_or_no_access: 'integrations.errorNotFound',
  sso_required: 'integrations.errorSsoRequired',
  host_unreachable: 'integrations.errorHostUnreachable',
  unsupported_host: 'integrations.errorUnsupportedHost',
  invalid_input: 'integrations.errorInvalidInput',
  not_open: 'integrations.errorNotOpen',
  timed_out: 'integrations.errorTimedOut',
  key_rejected: 'integrations.errorKeyRejected',
  generic: null,
} as const satisfies Record<IntegrationError['type'], string | null>;

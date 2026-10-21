import { getIntegrationName } from '@renderer/features/integrations/integration-display';
import { IntegrationIcon } from '@renderer/features/integrations/integration-icon';
import { useIntegrationsContext } from '@renderer/features/integrations/integrations-provider';
import { cn } from '@renderer/utils/utils';
import type { LinkedIssue } from '@shared/core/linked-issue';

/** 一个集成的图标,带可读名。从旧 issue 选择器里搬出来 —— 那个选择器随旧新建弹窗删了(#5690)。 */
export function ProviderLogo({
  provider,
  className,
  size = 14,
}: {
  provider: LinkedIssue['provider'];
  className?: string;
  size?: number;
}) {
  const { integrationById } = useIntegrationsContext();

  return (
    <span
      role="img"
      aria-label={getIntegrationName(integrationById, provider)}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-visible align-middle leading-none',
        className ?? 'h-3.5 w-3.5'
      )}
    >
      <IntegrationIcon provider={provider} size={size} />
    </span>
  );
}

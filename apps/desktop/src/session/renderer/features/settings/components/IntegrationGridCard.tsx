import { CircleAlert } from '@/lib/icons'
import { IntegrationIcon } from '@renderer/features/integrations/integration-icon';
import { useIntegrationAccounts } from '@renderer/features/integrations/use-integration-accounts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import type { IntegrationItem } from './IntegrationsCard';

export function IntegrationGridCard({
  integration,
  selected,
  onSelect,
}: {
  integration: IntegrationItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="flex h-full min-h-0">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          // @@@state-ladder-mix (#2322) 这张卡以前三态里有两态是**死的**:静止取 `bg-background-1`
          // (= `--card`),悬浮和选中都取 `bg-background-2`(= `--bg-elevated`)—— 而这两个 token
          // 在明暗两套里是**同一个色**(暗 #1a1c24 / 明 #fff)。于是鼠标划过没反应、选中也看不出来,
          // 只有按下那档(`bg-background-3` = `--muted`)是真的。
          // 现在:悬浮/按下改叠状态层(与全仓同一条阶梯,不依赖容器色阶是否塌),
          // 选中留给唯一真的有区别的那一级。层走 background-image、选中走 background-color,
          // 两者不抢同一个属性,所以「选中 + 悬浮」是叠加而不是替换。
          'group relative flex w-full items-center gap-4 rounded-lg border border-border bg-background-1 p-4 text-left text-foreground transition-all hover:state-hover-layer active:state-press-layer',
          // 选中还额外换边框色:这张卡的容器色阶塌得只剩一级可用,单靠底色的话
          // 「未选中按下」(明色下 = #fff 叠 5.1% 黑 ≈ rgb(242,242,242))和
          // 「选中静止」(bg-background-3 = rgb(243,244,246))几乎一模一样,按一下
          // 就像选中了。边框不参与那条塌掉的阶梯,选中与否一眼可分。
          // 同款写法见 onboarding/import-source-selector。
          selected && 'border-border-primary bg-background-3'
        )}
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-foreground/10">
          <IntegrationIcon provider={integration.id} icon={integration.icon} size={32} />
        </span>
        <span
          className={cn(
            'flex min-w-0 flex-1 flex-col gap-0.5',
            integration.connectionError && 'pr-6'
          )}
        >
          <span className="text-sm font-medium text-foreground">{integration.name}</span>
          <span className="truncate text-sm text-foreground-muted">{integration.description}</span>
        </span>
        {integration.multiAccount && integration.isConfigured && <AccountCount integrationId={integration.id} />}
        {integration.connectionError && (
          <ConnectionIssueIndicator
            providerName={integration.name}
            error={integration.connectionError}
          />
        )}
      </button>
    </div>
  );
}

/** 列表行右侧的「N 个账号」:只给能连多个账号的那几家;读不到就不写(❌ 写成 0)。 */
function AccountCount({ integrationId }: { integrationId: string }) {
  const { translate } = useSessionMessages();
  const { supported, accounts } = useIntegrationAccounts(integrationId, true, { check: false });
  if (!supported || accounts.length === 0) return null;
  return (
    <span className="shrink-0 text-xs text-foreground-muted">
      {translate('integrations.accountCount', { count: accounts.length })}
    </span>
  );
}

export function ConnectionIssueIndicator({
  providerName,
  error,
}: {
  providerName: string;
  error: string;
}) {
  const { translate } = useSessionMessages();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="text-foreground-destructive absolute top-3 right-3 inline-flex h-5 w-5 items-center justify-center rounded-full"
            aria-label={translate('integrations.connectionIssueTitle', { name: providerName })}
          >
            <CircleAlert className="h-4 w-4" />
          </span>
        }
      />
      {/* @@@raw detail — provider 返回的连接错误原文优先,回落到本地化外壳。 */}
      <TooltipContent side="top">{error || translate('integrations.connectionIssue')}</TooltipContent>
    </Tooltip>
  );
}

import { ExternalLink } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { DialogTitle } from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AgentPayload } from '@shared/core/agents/agent-payload';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

function formatSupportsText(translate: Translate, agent: AgentPayload): string {
  const capabilities = [translate('agentsPage.capabilityPrompts')];
  if (agent.capabilities.hooks.kind !== 'none')
    capabilities.push(translate('agentsPage.capabilityHooks'));
  if (agent.capabilities.sessions.kind !== 'stateless')
    capabilities.push(translate('agentsPage.capabilitySessions'));
  return translate('agentsPage.supports', { capabilities: capabilities.join('、') });
}

/**
 * 面板的卡头 = 这一家的 App 图标 + 名字(#6157)。
 *
 * 像 App Store 的详情页:一眼先认出「这是哪个 App」,它就是这张弹窗的标题。❌ 不再在上面
 * 另起一行小字「智能体设置 / 安装智能体」—— 那是家具,不是信息;装没装由下一行的状态说。
 * 名字就是 `DialogTitle`,读屏读到的标题与眼睛看到的是同一个词。
 */
export const AgentModalHeaderSection = observer(function AgentModalHeaderSection({
  agent,
  dimmed,
}: {
  agent: AgentPayload;
  /** 未安装:图标与网格里同样灰化。 */
  dimmed: boolean;
}) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex min-w-0 items-center gap-4">
      <AppIcon id={agent.id} size={64} dimmed={dimmed} />
      <div className="flex min-w-0 flex-col gap-1">
        {/* @@@raw agent name — agent 名是 provider 数据,只做插值。 */}
        <div className="flex min-w-0 items-center gap-2">
          <DialogTitle className="truncate text-xl font-medium text-foreground">{agent.name}</DialogTitle>
        </div>
        <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-foreground-muted">
          <span>{formatSupportsText(translate, agent)}</span>
          {agent.websiteUrl && (
            <a
              href={agent.websiteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-foreground-muted hover:text-foreground"
            >
              {translate('agentsPage.viewWebsite')}
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </p>
      </div>
    </div>
  );
});

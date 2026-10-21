import { observer } from 'mobx-react-lite';
import { useTranslation } from 'react-i18next';
import { readAssistantShellBridge, type AssistantSetupStep } from '@/lib/assistantShellBridge';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/Button';
import type { AssistantContext } from './assistant-context';
import { accountNote, ConnectorLists, HomeIntegrations, useOpenConnector } from './assistant-home-integrations';

/**
 * 开通咕咕的后半(product spec 开通那段,#7349,照 dots),它已经安好家了:
 * - 连应用:它家那台的「账号」那一段(住云上叫云端),与「连接应用」页同一份列表;点一家直接弹连接框。可以跳过。
 *   连完 / 跳过就直接进 App,它在私聊里先开口(初始化任务里那一步)—— dots 开口前没有「一切就绪」那一屏,这里也不再有。
 * - 「一切就绪」只留给升级前已经停在那一步的人(本机记着 'ready'),点「此刻出发」照常进 App。
 * 前半(认识咕咕 → 住在哪 → 安家)在壳那一侧(components/assistant/AssistantOnboarding)。
 */
export function AssistantSetupFinish({ context, step }: { context: AssistantContext; step: Exclude<AssistantSetupStep, 'shell'> }) {
  const advance = (next: AssistantSetupStep | null) => readAssistantShellBridge()?.getActions()?.advanceSetup(next);
  return step === 'connect' ? <ConnectStep context={context} onDone={() => advance(null)} /> : <ReadyStep context={context} onDone={() => advance(null)} />;
}

function ConnectStep({ context, onDone }: { context: AssistantContext; onDone: () => void }) {
  const { t } = useTranslation('assistant');
  return (
    <div className="ta-onb ta-onb-wide" data-testid="assistant-setup-connect">
      <h1 className="ta-onb-title">{t('setup.connectTitle')}</h1>
      <p className="ta-onb-sub">{accountNote(context, t)}</p>
      <div className="ta-onb-list">
        <HomeIntegrations context={context}>
          <ConnectList context={context} />
        </HomeIntegrations>
      </div>
      <div className="ta-onb-actions">
        <Button variant="secondary" size="lg" className="rounded-full flex-1" onClick={onDone} data-testid="assistant-setup-skip">
          {t('setup.skip')}
        </Button>
        <Button variant="primary" size="lg" className="rounded-full flex-1" onClick={onDone} data-testid="assistant-setup-continue">
          {t('setup.continue')}
        </Button>
      </div>
    </div>
  );
}

const ConnectList = observer(function ConnectList({ context }: { context: AssistantContext }) {
  const open = useOpenConnector(context.home);
  return <ConnectorLists onOpen={open} />;
});

function ReadyStep({ context, onDone }: { context: AssistantContext; onDone: () => void }) {
  const { t } = useTranslation('assistant');
  const { assistant } = context;
  const owner = context.ownerName?.trim();
  return (
    <div className="ta-onb" data-testid="assistant-setup-ready">
      <Avatar name={assistant.display_name} avatarUrl={assistant.avatar} seed={assistant.id} size={96} isAgent harnessBadge={false} />
      <h1 className="ta-onb-title">{owner ? t('setup.readyTitle', { name: owner }) : t('setup.readyTitleNoName')}</h1>
      <p className="ta-onb-sub">{t('setup.readySub', { name: assistant.display_name })}</p>
      <div className="ta-onb-actions">
        <button type="button" className="ta-solid-btn" onClick={onDone} data-testid="assistant-setup-go">
          {t('setup.go')}
        </button>
      </div>
    </div>
  );
}

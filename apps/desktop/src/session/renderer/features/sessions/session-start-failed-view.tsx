import { useState } from 'react';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { AgentDetailModal } from '@renderer/features/settings/agents-page/AgentDetailModal';
import type { RuntimeUpgradeRequirement } from '@shared/core/sessions/runtime-upgrade';
import type { SessionStartupFailure } from './stores/session-startup-failures';
import type { GuguCatalogReason } from '@gugu/session-core/session-record/contract';
import {
  refreshPlatformModelCatalogs,
  usePlatformModelCatalog,
} from '@renderer/features/sessions/session-config/platform-model-catalog';
import {
  failureReason,
  failureText,
  guguReasonCopy,
  guguReasonText,
  reasonActions,
  type GuguReasonButton,
} from './gugu-reason';
import { runningPlatformModelId } from '@renderer/features/sessions/session-config/platform-model-selection';
import { openMembershipPage } from '@renderer/features/sessions/session-config/use-composer-model-options';

const BUTTON_TEST_IDS: Record<GuguReasonButton['kind'], string> = {
  'retry': 'session-start-retry',
  'switch-model': 'session-start-switch-model',
  'join-membership': 'session-start-join-membership',
  'joined': 'session-start-membership-retry',
  'signed-in': 'session-start-signed-in-retry',
};

/** 失败页底下那一排按钮:原因表给的(`reasonActions`),重来的那颗在重试中禁用并如实写「正在重试…」。 */
function FailureButtons({ buttons, retrying }: { buttons: GuguReasonButton[]; retrying: boolean }) {
  const { translate } = useSessionMessages();
  if (!buttons.length) return null;
  return (
    <div className="flex items-center gap-2">
      {buttons.map((button, index) => {
        const reruns = button.kind === 'retry' || button.kind === 'joined' || button.kind === 'signed-in';
        return (
          <Button
            key={button.kind}
            type="button"
            size="sm"
            variant={index === 0 ? 'secondary' : 'ghost'}
            disabled={reruns && retrying}
            onClick={button.run}
            data-testid={BUTTON_TEST_IDS[button.kind]}
          >
            {reruns && retrying ? translate('taskError.sessionStartRetrying') : button.label}
          </Button>
        );
      })}
    </div>
  );
}

/**
 * 会话没启动起来时，内容区里显示的东西。
 *
 * 它占的是加载态那一格 —— 加载 / 失败 / 内容三态在同一个位置交接，
 * ❌ 不是在别处再开一块。为什么必须有这一格：加载态的撤下条件是
 * 「画面上真的有东西了」，而失败的会话永远满足不了它；缺了这一格
 * 那个圈就会一直转下去（owner 实测 codex 转满 90 秒仍在转）。
 *
 * 这一侧就是任务页上唯一说这次失败的地方(#7103 同一次失败只说一次:❌ 角落再弹一条)。
 * 咕咕这一侧的失败按原因表说、给原因表的按钮;咕咕以外的(harness、provider)递它的原话(#4657)+ 重试。
 *
 * ⚠️ 「正在重试」不显示成加载态：那会把一段仍然可能失败的过程读成「没事了」。
 * 按账本的口径 —— 出口禁用 + 如实写「正在重试…」。
 */
export function SessionStartFailedView({
  failure,
  onRetry,
  providerId,
  onSwitchModel,
}: {
  failure: SessionStartupFailure;
  onRetry: () => void;
  /** 这条会话的 harness —— 原因说的是某个咕咕模型时按它取目录,说出是哪个模型。 */
  providerId?: string | null;
  /** 打开这条会话的模型菜单;给了才摆「换模型」。 */
  onSwitchModel?: () => void;
}) {
  const { translate } = useSessionMessages();
  const reason = failureReason(failure.message);
  if (!failure.runtimeUpgrade && reason && guguReasonCopy(reason).named) {
    return (
      <ModelStartFailedView
        reason={reason}
        failure={failure}
        providerId={providerId ?? null}
        onRetry={onRetry}
        onSwitchModel={onSwitchModel}
      />
    );
  }
  // 咕咕以外的失败(harness / provider,不带原因码)与版本太低:重来一次就是那一颗按钮。
  const buttons = reasonActions(reason ?? 'service-unavailable', { retry: onRetry, switchModel: onSwitchModel }, translate);
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3"
      role="status"
      data-testid="session-start-failed"
      data-reason={reason ?? 'harness'}
    >
      <p className="max-w-[32ch] text-center text-[length:var(--font-caption)] leading-normal opacity-60">
        {translate('taskError.sessionStartFailed')}
      </p>
      {failure.runtimeUpgrade ? (
        <RuntimeUpgradeNotice requirement={failure.runtimeUpgrade} disabled={failure.retrying} onPanelClosed={onRetry} />
      ) : (
        <p data-testid="session-start-failure-detail" className="max-w-[64ch] text-center text-sm">
          {failureText(failure.message, translate)}
        </p>
      )}
      <FailureButtons buttons={buttons} retrying={failure.retrying} />
    </div>
  );
}

/**
 * 原因说的是某个咕咕模型(要会员 #7092 / 下架了 #7103):说**模型**,❌「这个任务没能启动」—— 任务没坏,
 * owner 原话「只是个模型不能用」。按钮照原因表:要会员给开通会员 + 我开好了(再起一次,真去问),下架了给换模型。
 */
function ModelStartFailedView({
  reason,
  failure,
  providerId,
  onRetry,
  onSwitchModel,
}: {
  reason: GuguCatalogReason;
  failure: SessionStartupFailure;
  providerId: string | null;
  onRetry: () => void;
  onSwitchModel?: () => void;
}) {
  const { translate } = useSessionMessages();
  const catalog = usePlatformModelCatalog(providerId, 'tui', failure.sessionId);
  const modelId = runningPlatformModelId(
    catalog.sessionSelection,
    null,
    catalog.models.map((model) => model.id)
  );
  const modelName = modelId
    ? (catalog.models.find((model) => model.id === modelId)?.displayName ?? null)
    : null;
  const buttons = reasonActions(reason, {
    retry: () => {
      // 会员可能是在手机或别的窗口开的:先让模型下拉重取目录,再起一次。
      refreshPlatformModelCatalogs();
      onRetry();
    },
    switchModel: onSwitchModel,
    joinMembership: openMembershipPage,
  }, translate);
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3"
      role="status"
      data-testid="session-start-failed"
      data-reason={reason}
    >
      <p data-testid="session-start-failure-detail" className="max-w-[64ch] text-center text-sm">
        {guguReasonText(reason, translate, modelName)}
      </p>
      <FailureButtons buttons={buttons} retrying={failure.retrying} />
    </div>
  );
}

/**
 * #6341 harness 版本低于这一版客户端的下界:说清「要几、现在是几、是哪一份」,出口是这一家
 * **正式的安装与更新面板**(`AgentDetailModal`,与设置 → 智能体点进去的是同一个组件)——
 * 托管安装、换用本机另一份、手动指定、安装进度都在那里,❌ 不在失败页另写一套。
 * 面板关上即重试一次:装好了就起来;没动或还不够新,主进程再判一次、这里如实再显示。
 */
function RuntimeUpgradeNotice({
  requirement,
  disabled,
  onPanelClosed,
}: {
  requirement: RuntimeUpgradeRequirement;
  disabled: boolean;
  onPanelClosed: () => void;
}) {
  const { translate } = useSessionMessages();
  const { data: agents } = useAgents();
  const [panelOpen, setPanelOpen] = useState(false);
  const harnessName = agents?.find((agent) => agent.id === requirement.providerId)?.name ?? requirement.providerId;

  return (
    <div className="flex max-w-[64ch] flex-col items-center gap-2 text-center text-sm" data-testid="session-runtime-upgrade">
      <p data-testid="session-start-failure-detail">
        {translate('taskError.runtimeUpgradeRequired', {
          harnessName,
          supportedFloor: requirement.supportedFloor,
          installedVersion: requirement.installedVersion,
        })}
      </p>
      {requirement.executable ? (
        <p className="break-all font-mono text-[length:var(--font-caption)] opacity-60">
          {translate('taskError.runtimeUpgradeExecutable', { executable: requirement.executable })}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        disabled={disabled}
        onClick={() => setPanelOpen(true)}
        data-testid="session-runtime-upgrade-open-installer"
      >
        {translate('taskError.runtimeUpgradeOpenInstaller', { harnessName })}
      </Button>
      <p className="text-[length:var(--font-caption)] opacity-60">{translate('taskError.runtimeUpgradeSelfHint')}</p>
      <AgentDetailModal
        agentId={panelOpen ? requirement.providerId : null}
        onClose={() => {
          setPanelOpen(false);
          onPanelClosed();
        }}
      />
    </div>
  );
}

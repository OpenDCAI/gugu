import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ComposerModelMenu,
  resolveComposerModelPanel,
  type ComposerEffortItem,
  type ComposerModelItem,
} from '@gugu/session-ui/react/components';
import { platformModelIdFromOption } from '@/session/shared/platform-model-id';
import { platformEffortFacts, resolveCreateEfforts } from '@shared/core/agents/create-efforts';
import { requestSessionReload } from '@renderer/features/sessions/request-session-reload';
import { SessionReloadConfirm } from '@renderer/features/sessions/session-reload-confirm';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { findSessionHostBridge } from '@renderer/lib/electron-api';
import { useHarnessModelCatalog } from '@renderer/lib/stores/use-harness-model-catalog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { localizeEffortOptions } from '../session-config/effort-options';
import { sessionStartupFailures } from '../stores/session-startup-failures';
import { useTerminalModelMenuRequest } from './terminal-model-menu-request';
import { usePlatformModelCatalog } from '../session-config/platform-model-catalog';
import { composerModelFooter, useComposerModelOptions } from '../session-config/use-composer-model-options';
import { useHarnessModelOptions } from '../session-config/use-harness-model-options';
import {
  planTerminalEffortSwitch,
  planTerminalModelSwitch,
  terminalSelectedOptionId,
  type TerminalEffortChange,
} from './terminal-model-switch';

type PendingSwitch = {
  model?: { id: string; source: 'platform' | 'own'; optionId: string };
  effort?: TerminalEffortChange;
  label: string;
};

/**
 * spec session-terminal-model-switch —— 终端会话顶栏上的模型与思考按钮。
 *
 * 点开的是与通用模式输入框**同一张卡**(`ComposerModelMenu` + `useComposerModelOptions`):
 * 「咕咕提供的模型」与「你的 X 模型」两档全放,底下是「思考」档位滑杆。平台那档按 `tui` 取 ——
 * 同一个 harness 在两种展示上能拿到的咕咕模型不一样(注入拓扑不同),❌ 别拿通用模式那份目录来画。
 *
 * 换模型、换档位一律「确认 → 宿主按新记录重开 → 续上同一条会话」(见 `terminal-model-switch`):
 * 两者都是 spawn 那一刻进 argv 的,活着的 TUI 进程改不了。重开会杀掉 TUI 进程,正在跑的那一轮随之被打断。
 * 终端认的是与进程无关的稳定 pty id,宿主在同一个 id 上重新起一条 pty,这里一行重连都不必写。
 *
 * 档位清单与新建页同一个来源(`resolveCreateEfforts`),按「正在跑的那个模型」取。
 * 一条模型、一个档位都给不出时整颗按钮不渲染(`resolveComposerModelPanel` → hidden)。
 *
 * `notStarted`(#7092):这条会话从没起来过(首启失败,如会员模型被拒)。没有进程可打断,所以 ❌ 不弹重开确认:
 * 宿主只把新选择记进会话记录,这里接着按正常首启再起一次(失败账本那条重试)。
 */
export function TerminalModelMenu({
  sessionId,
  providerId,
  recordedModel,
  recordedEffort,
  notStarted = false,
}: {
  sessionId: string;
  providerId: string;
  recordedModel?: string | null;
  recordedEffort?: string | null;
  notStarted?: boolean;
}) {
  const { translate } = useSessionMessages();
  const showConfirm = useShowModal('confirmActionModal');
  const platformCatalog = usePlatformModelCatalog(providerId, 'tui', sessionId);
  // #7056 会员中途到期:续期发现这条会话的模型被收掉了 ⇒ 刷新目录(别的会员模型从菜单里撤掉)。
  // 终端里 agent 自己那一轮被网关拒,说明由网关自己给(#7092),❌ 在本机中转里改写。
  const refreshPlatformCatalogRef = useRef(platformCatalog.refresh);
  refreshPlatformCatalogRef.current = platformCatalog.refresh;
  useEffect(() => {
    const api = findSessionHostBridge();
    if (!api) return;
    return api.eventOn('session:platform-membership-changed', (value) => {
      if ((value as { sessionId?: unknown } | null)?.sessionId === sessionId) refreshPlatformCatalogRef.current();
    });
  }, [sessionId]);
  const harnessOptions = useHarnessModelOptions(providerId, 'tui');
  const harnessCatalog = useHarnessModelCatalog(providerId, 'tui');
  const { data: agents } = useAgents();
  const capabilities = agents?.find((agent) => agent.id === providerId)?.capabilities ?? null;

  /**
   * 重开成功后到记录被读回之前,先按用户刚选的那条高亮。平台那一路由下面的 `retry()` 读回;
   * 自有模型与档位由宿主写进 `config`,渲染层的会话快照未必立刻跟上 —— 不先记一笔,
   * 按钮会在成功之后还写着旧值。`effort` 用 `undefined` 表示「没改过」,`null` 是「改回了默认」。
   */
  const [applied, setApplied] = useState<{ optionId?: string; effort?: string | null }>({});
  useEffect(() => setApplied({}), [sessionId]);

  const recordedSelected = terminalSelectedOptionId({
    sessionSelection: platformCatalog.sessionSelection,
    platformModelIds: platformCatalog.models.map((model) => model.id),
    recordedModel,
  });
  const selectedOptionId = applied.optionId ?? recordedSelected;
  // 正在用的那个平台模型要会员了、或被他在设置里关掉了,也照列 —— 触发器写的就是它(见 `composerModelOptions`)。
  const options = useComposerModelOptions(
    harnessOptions,
    platformCatalog.models,
    providerId,
    selectedOptionId ? platformModelIdFromOption(selectedOptionId) : null
  );
  const currentEffort =
    applied.effort !== undefined ? applied.effort : recordedEffort?.trim() || null;

  const effortsFor = useCallback(
    (optionId: string | undefined) => {
      const platformId = optionId ? platformModelIdFromOption(optionId) : null;
      return resolveCreateEfforts({
        state: harnessCatalog.state,
        effortCapability: capabilities?.effort,
        staticModelsCapability:
          capabilities?.models.kind === 'selectable' ? capabilities.models : undefined,
        model: platformId === null ? (optionId ?? null) : null,
        platformModel: platformEffortFacts(platformId, platformCatalog.models),
        leg: 'tui',
      });
    },
    [capabilities, harnessCatalog.state, platformCatalog.models]
  );
  const efforts = useMemo(() => effortsFor(selectedOptionId), [effortsFor, selectedOptionId]);
  // 档名走词表 —— 插件那份是硬编码中文,原样摆出来英文壳里就漏中文(见 effort-options.ts)。
  const effortOptions = useMemo(
    () => localizeEffortOptions(efforts?.options ?? null, translate),
    [efforts, translate]
  );

  const modelItems = useMemo<ComposerModelItem[]>(
    () => (options ? Object.entries(options).map(([id, option]) => ({ id, ...option })) : []),
    [options]
  );
  const effortItems = useMemo<ComposerEffortItem[]>(
    () =>
      effortOptions ? Object.entries(effortOptions).map(([id, option]) => ({ id, ...option })) : [],
    [effortOptions]
  );
  const panel = resolveComposerModelPanel({
    modelCount: modelItems.length,
    effortCount: effortItems.length,
    unlock: false,
  });

  const [pending, setPending] = useState<PendingSwitch | null>(null);
  const [reloading, setReloading] = useState(false);
  // 失败页上那颗「换模型」(#7092):只认挂上之后的新请求,❌ 一挂上就把面板弹开。
  const menuRequests = useTerminalModelMenuRequest(sessionId);
  const menuRequestsAtMount = useRef(menuRequests);

  /** 宿主按新选择重开(或从没起来过时只记下);成了返回 true,没成就把原话给用户。 */
  const apply = useCallback(
    async (target: PendingSwitch): Promise<boolean> => {
      setReloading(true);
      try {
        const result = await requestSessionReload({
          sessionId,
          reason: 'model-switch',
          ...(target.model ? { model: target.model.id, modelSource: target.model.source } : {}),
          ...(target.effort !== undefined ? { effort: target.effort } : {}),
        });
        if (!result.ok) {
          // 原话直接给用户 —— 宿主已经把记录退回原设置,这句话说的是「为什么没换成」。
          showConfirm({
            title: translate('chat.modelSwitchFailedTitle', { target: target.label }),
            description: result.error ?? '',
            confirmLabel: translate('common.close'),
            onSuccess: () => undefined,
          });
          return false;
        }
        setApplied((current) => ({
          optionId: target.model?.optionId ?? current.optionId,
          effort: target.effort !== undefined ? target.effort : current.effort,
        }));
        if (target.model) platformCatalog.retry();
        // 从没起来过:宿主只记下了选择,这里按正常首启再起一次。
        if (result.notStarted) sessionStartupFailures.retry(sessionId);
        return true;
      } finally {
        setReloading(false);
      }
    },
    [sessionId, platformCatalog, showConfirm, translate]
  );

  /** 换模型 / 换档位:跑过的会话先确认(重开会打断这一轮),从没起来过的直接换。 */
  const propose = useCallback(
    (target: PendingSwitch) => {
      if (notStarted) void apply(target);
      else setPending(target);
    },
    [apply, notStarted]
  );

  const handleModelChange = useCallback(
    (optionId: string) => {
      const plan = planTerminalModelSwitch({
        optionId,
        selectedOptionId,
        options,
        recordedEffort: currentEffort,
        targetEffortIds: Object.keys(effortsFor(optionId)?.options ?? {}),
      });
      if (plan.kind === 'none' || !plan.model) return;
      propose({
        model: { ...plan.model, optionId },
        ...(plan.effort !== undefined ? { effort: plan.effort } : {}),
        label: plan.label,
      });
    },
    [currentEffort, effortsFor, options, selectedOptionId, propose]
  );

  const handleEffortChange = useCallback(
    (effortId: string) => {
      const plan = planTerminalEffortSwitch({
        effortId,
        recordedEffort: currentEffort,
        options: effortOptions,
      });
      if (plan.kind === 'none') return;
      propose({
        effort: plan.effort,
        label: `${translate('composer.effort')} ${plan.effortName ?? translate('composer.default')}`,
      });
    },
    [currentEffort, effortOptions, translate, propose]
  );

  const confirm = useCallback(async () => {
    const target = pending;
    if (!target) return;
    if (await apply(target)) setPending(null);
  }, [pending, apply]);

  if (panel.kind === 'hidden') return null;

  return (
    <span data-testid="terminal-model-switch" className="flex items-center">
      <ComposerModelMenu
        panel={panel}
        disabled={reloading}
        modelItems={modelItems}
        selectedModel={selectedOptionId}
        onModelChange={handleModelChange}
        openRequest={menuRequests - menuRequestsAtMount.current}
        // 底部「管理模型 / 升级解锁更多模型」(#7056),三个模型菜单同一份。
        {...composerModelFooter(platformCatalog.models)}
        effortItems={effortItems}
        selectedEffort={currentEffort && effortOptions?.[currentEffort] ? currentEffort : undefined}
        onEffortChange={handleEffortChange}
        defaultEffort={efforts?.defaultId ?? undefined}
      />
      <SessionReloadConfirm
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next && !reloading) setPending(null);
        }}
        reason="model-switch"
        target={pending?.label ?? ''}
        isReloading={reloading}
        onConfirm={confirm}
      />
    </span>
  );
}

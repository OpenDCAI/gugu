import { useForm } from '@tanstack/react-form';
import { ChevronDown, ChevronRight, Plus, RotateCcw, Trash2 } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useState } from 'react';
import { parseEnvAssignmentPaste, replaceEnvEntryWithPaste } from '@renderer/lib/env-paste';
import { Button } from '@renderer/lib/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import { useAgentSettings } from '@renderer/lib/stores/use-agent-settings';
import type { ProviderCustomConfig } from '@shared/core/app-settings';
import { OutdatedSourceBadge } from './agent-status-badge';
import type { RegistryRow } from './installation-sources';

type EnvEntry = { key: string; value: string };

export interface AgentAdvancedSectionProps {
  agentId: string;
  /** 各下载源(含版本读数)。空数组 = 这一家只有一个下载点,那一项就不摆。 */
  registries: RegistryRow[];
  /** 用户手动指定的下载源;undefined = 自动(主进程按测速选源)。 */
  registry: string | undefined;
  onRegistryChange: (registry: string | undefined) => void;
}

function makeDefaultValues(cfg: ProviderCustomConfig | undefined) {
  return {
    extraArgs: cfg?.extraArgs ?? '',
    envEntries: cfg?.env
      ? (Object.entries(cfg.env).map(([key, value]) => ({ key, value })) as EnvEntry[])
      : ([] as EnvEntry[]),
  };
}

/**
 * 「高级」——**默认折叠**:下载源、附加参数、环境变量(#6157 / spec)。
 *
 * 「自定义路径」已经挪到面板上「用哪一份」那三行里(owner 2026-09-22:来源就三种,本机找到的 /
 * 咕咕管理 / 自定义路径,三者并列)。这里排成**左标签、右控件**两列,每一项的控件左缘对齐。
 * ❌ 不再一项一个排法(按钮贴右、输入框通栏、按钮又贴左),owner 截图里那一片就是这样散的。
 *
 * 以下为旧注释:
 *
 * 那两项是 spec 点名的:自定义可执行文件路径、手动指定下载源。用户面上的常规路径里不该出现
 * 「路径」和「源」这两个词(owner:「自己装的不应该有多个版本,也不会需要糙到有路径」),
 * 但知道自己要什么的人得有一个覆盖口,所以它们收在这里。
 *
 * 「附加参数」「环境变量」本来就在这一格里,原样留着 —— ❌ 不往这里加第三、第四项。
 */
export const AgentAdvancedSection = observer(function AgentAdvancedSection({
  agentId,
  registries,
  registry,
  onRegistryChange,
}: AgentAdvancedSectionProps) {
  const [open, setOpen] = useState(false);
  const { translate } = useSessionMessages();
  const { value: storedConfig, isOverridden, isLoading, update, reset } = useAgentSettings(agentId);

  const form = useForm({ defaultValues: makeDefaultValues(storedConfig) });

  // Re-sync form when external config changes (e.g. after a reset from outside).
  useEffect(() => {
    if (isLoading) return;
    const next = makeDefaultValues(storedConfig);
    form.setFieldValue('extraArgs', next.extraArgs);
    form.setFieldValue('envEntries', next.envEntries);
  }, [isLoading, storedConfig, isOverridden, form]);

  const commit = useCallback(() => {
    const { extraArgs, envEntries } = form.state.values;
    const envRecord: Record<string, string> = {};
    for (const { key, value } of envEntries) {
      const k = key.trim();
      if (k && /^[A-Za-z_]\w*$/.test(k)) {
        envRecord[k] = value;
      }
    }

    const isAtDefaults = extraArgs.trim() === '' && envEntries.every((e) => !e.key.trim());

    if (isAtDefaults) {
      reset(undefined, {
        onError: (err) => log.error('Failed to reset agent config:', err),
      });
    } else {
      const config: ProviderCustomConfig = {
        ...(storedConfig ?? {}),
        extraArgs: extraArgs.trim() || undefined,
        env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
      };
      update(config, {
        onError: (err) => log.error('Failed to save agent config:', err),
      });
    }
  }, [form, storedConfig, reset, update]);

  const handleResetToDefaults = useCallback(() => {
    form.setFieldValue('extraArgs', '');
    form.setFieldValue('envEntries', []);
    reset(undefined, {
      onError: (err) => log.error('Failed to reset agent config:', err),
    });
  }, [form, reset]);

  // @@@6088 这一层从前自带 `min-h-0 flex-1 overflow-y-auto px-4`,因为抽屉里它是与上半部分
  // 并列的第二个滚动区。居中模态框只有**一个**滚动区(`DialogContentArea`),这里再开一个
  // 会让「高级设置」展开后在弹窗内部套出第二条滚动条,而上半部分反而钉住不动。
  // 高级排在最后,上边一条细线与账号 / 状态分开(line budget:段与段之间一条线,段内不再加框)。
  return (
    <div className="border-t pt-2">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          type="button"
          data-testid="agent-advanced-trigger"
          className="flex w-full items-center justify-between rounded-md py-2 text-sm font-medium text-foreground-muted hover:text-foreground"
        >
          <span className="flex h-6 items-center gap-1.5">
            <Label>{translate('agentsPage.advancedSettings')}</Label>
            <ChevronRight
              className={cn('size-3.5', 'transition-transform', open ? 'rotate-90' : '')}
            />
          </span>
          {isOverridden && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1.5 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                handleResetToDefaults();
              }}
            >
              <RotateCcw className="size-3.5" />
              {translate('agentsPage.resetToDefaults')}
            </Button>
          )}
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-4 gap-y-4 pt-2 pb-3">
            {/* 下载源。默认「自动」—— 主进程按测速自己挑(spec:下载源不让用户选,这里是覆盖口)。 */}
            {registries.length > 0 && (
              <>
                <RowLabel>{translate('agentsPage.manualRegistry')}</RowLabel>
                <div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      data-testid="registry-trigger"
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-sm text-foreground outline-none hover:bg-row-hover focus-visible:bg-row-hover"
                    >
                      {registries.find((r) => r.registry === registry)?.label ??
                        translate('agentsPage.sourceAuto')}
                      <ChevronDown className="size-3.5 text-foreground-passive" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuRadioGroup
                        value={registry ?? ''}
                        onValueChange={(next) => onRegistryChange(next === '' ? undefined : next)}
                      >
                        {/* 「自动」是**默认**,所以它是这一组的第一行。 */}
                        <DropdownMenuRadioItem value="">
                          {translate('agentsPage.sourceAuto')}
                        </DropdownMenuRadioItem>
                        {registries.map((r) => (
                          <DropdownMenuRadioItem key={r.registry} value={r.registry} disabled={r.unusable}>
                            <span className="truncate">{r.label}</span>
                            <span className="font-mono text-xs text-foreground-passive">
                              {r.unusable
                                ? translate('agentsPage.sourceMissingPlatformBuild')
                                : r.loading
                                  ? translate('agentsPage.sourceVersionChecking')
                                  : r.version
                                    ? `v${r.version}`
                                    : translate('agentsPage.sourceVersionUnknown')}
                            </span>
                            {r.outdated && <OutdatedSourceBadge />}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </>
            )}

            {/* 附加参数 */}
            <form.Field name="extraArgs">
              {(field) => (
                <>
                  <RowLabel htmlFor="agent-extraArgs" tooltip={translate('agentsPage.extraArgsTooltip')}>
                    {translate('agentsPage.additionalParameters')}
                  </RowLabel>
                  <Input
                    id="agent-extraArgs"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={() => commit()}
                    placeholder={translate('agentsPage.additionalParametersPlaceholder')}
                    className="font-mono text-sm"
                  />
                </>
              )}
            </form.Field>

            {/* 环境变量 */}
            <form.Field name="envEntries">
              {(field) => (
                <>
                  <RowLabel tooltip={translate('agentsPage.environmentVariablesTooltip')}>
                    {translate('agentsPage.environmentVariables')}
                  </RowLabel>
                  <div className="flex min-w-0 flex-col items-start gap-2">
                    {field.state.value.map((entry, i) => (
                      <div key={i} className="flex w-full min-w-0 items-center gap-2">
                        <Input
                          value={entry.key}
                          placeholder={translate('agentsPage.envKeyPlaceholder')}
                          className="min-w-0 flex-1 font-mono text-sm"
                          onChange={(e) =>
                            field.handleChange(
                              field.state.value.map((v, idx) =>
                                idx === i ? { ...v, key: e.target.value } : v
                              )
                            )
                          }
                          onBlur={() => commit()}
                          onPaste={(e) => {
                            const pasted = parseEnvAssignmentPaste(e.clipboardData.getData('text'));
                            if (pasted.length === 0) return;
                            e.preventDefault();
                            field.handleChange(
                              replaceEnvEntryWithPaste(field.state.value, i, pasted)
                            );
                          }}
                        />
                        <Input
                          value={entry.value}
                          placeholder={translate('agentsPage.envValuePlaceholder')}
                          className="min-w-0 flex-1 font-mono text-sm"
                          onChange={(e) =>
                            field.handleChange(
                              field.state.value.map((v, idx) =>
                                idx === i ? { ...v, value: e.target.value } : v
                              )
                            )
                          }
                          onBlur={() => commit()}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          aria-label={translate('agentsPage.removeEnvEntry')}
                          onClick={() => {
                            field.handleChange(field.state.value.filter((_, idx) => idx !== i));
                            commit();
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() =>
                        field.handleChange([...field.state.value, { key: '', value: '' }])
                      }
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {translate('agentsPage.addVariable')}
                    </Button>
                  </div>
                </>
              )}
            </form.Field>

            {/* 改过默认值时一句话说清,❌ 不画黄色警告框:这是事实陈述,不是出了问题。 */}
            {isOverridden && (
              <p className="col-start-2 m-0 text-sm text-foreground-muted">
                {translate('agentsPage.customConfigurationApplied')}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});

/** 高级里左边那一列的标签。控件在右列,标签与控件第一行对齐。 */
function RowLabel({
  children,
  htmlFor,
  tooltip,
}: {
  children: React.ReactNode;
  htmlFor?: string;
  tooltip?: string;
}) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex min-h-8 items-center gap-1.5">
      <label htmlFor={htmlFor} className="text-sm text-foreground-muted">
        {children}
      </label>
      {tooltip && <InfoTooltip label={translate('agentsPage.moreInformation')} content={tooltip} contentClassName="max-w-[200px]" />}
    </div>
  );
}

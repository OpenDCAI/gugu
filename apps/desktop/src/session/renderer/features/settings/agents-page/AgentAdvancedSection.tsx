import { useForm } from '@tanstack/react-form';
import { ChevronRight, Plus, RotateCcw, Trash2 } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useState } from 'react';
import { parseEnvAssignmentPaste, replaceEnvEntryWithPaste } from '@renderer/lib/env-paste';
import { Button } from '@renderer/lib/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/lib/ui/select';
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { Input } from '@renderer/lib/ui/input';
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
  children?: React.ReactNode;
  compact?: boolean;
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
      : ([] as EnvEntry[])
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
  children,
  compact = false,
  registries,
  registry,
  onRegistryChange
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
        onError: (err) => log.error('Failed to reset agent config:', err)
      });
    } else {
      const config: ProviderCustomConfig = {
        ...(storedConfig ?? {}),
        extraArgs: extraArgs.trim() || undefined,
        env: Object.keys(envRecord).length > 0 ? envRecord : undefined
      };
      update(config, {
        onError: (err) => log.error('Failed to save agent config:', err)
      });
    }
  }, [form, storedConfig, reset, update]);

  const handleResetToDefaults = useCallback(() => {
    form.setFieldValue('extraArgs', '');
    form.setFieldValue('envEntries', []);
    reset(undefined, {
      onError: (err) => log.error('Failed to reset agent config:', err)
    });
  }, [form, reset]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="relative flex items-center justify-between gap-3">
        <CollapsibleTrigger
          type="button"
          data-testid="agent-advanced-trigger"
          className="flex w-full items-center justify-between text-sm font-semibold"
        >
          {translate(compact ? 'agentsPage.advanced' : 'agentsPage.advancedSettings')}
          <ChevronRight className={cn('absolute right-0 size-3.5 transition-transform', open && 'rotate-90')} />
        </CollapsibleTrigger>
        {isOverridden && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mr-6 shrink-0 gap-1.5 text-xs"
            onClick={handleResetToDefaults}
          >
            <RotateCcw className="size-3.5" />
            {translate('agentsPage.resetToDefaults')}
          </Button>
        )}
      </div>
      <CollapsibleContent className="pt-2">
        {children}
        <SettingsGroup>
          {registries.length > 0 && (
            <SettingsRow
              title={translate('agentsPage.manualRegistry')}
              description={translate('agentsPage.registryHint')}
              control={
                <Select
                  value={registry ?? ''}
                  onValueChange={(value) =>
                    onRegistryChange(value === '' ? undefined : String(value))
                  }
                >
                  <SelectTrigger
                    className="w-[156px]"
                    aria-label={translate('agentsPage.manualRegistry')}
                    data-testid="registry-trigger"
                  >
                    <SelectValue>
                      {registries.find((r) => r.registry === registry)?.label ??
                        translate('agentsPage.sourceAuto')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="">{translate('agentsPage.sourceAuto')}</SelectItem>
                    {registries.map((r) => (
                      <SelectItem key={r.registry} value={r.registry} disabled={r.unusable}>
                        <span>{r.label}</span>
                        <span className="font-mono text-xs text-foreground-muted">
                          {r.unusable
                            ? translate('agentsPage.sourceMissingPlatformBuild')
                            : r.loading
                              ? translate('agentsPage.sourceVersionChecking')
                              : r.version
                                ? `v${r.version}`
                                : translate('agentsPage.sourceVersionUnknown')}
                        </span>
                        {r.outdated && <OutdatedSourceBadge />}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
          )}
          <form.Field name="extraArgs">
            {(field) => (
              <SettingsRow
                title={
                  <>
                    <label htmlFor="agent-extraArgs">
                      {translate('agentsPage.additionalParameters')}
                    </label>
                    <InfoTooltip
                      label={translate('agentsPage.moreInformation')}
                      content={translate('agentsPage.extraArgsTooltip')}
                    />
                  </>
                }
                description={translate('agentsPage.extraArgsHint')}
                stack
                control={
                  <Input
                    id="agent-extraArgs"
                    className="w-[184px] font-mono text-sm"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={commit}
                    placeholder={translate('agentsPage.additionalParametersPlaceholder')}
                  />
                }
              />
            )}
          </form.Field>
          <form.Field name="envEntries">
            {(field) => (
              <SettingsRow
                title={
                  <>
                    {translate('agentsPage.environmentVariables')}
                    <InfoTooltip
                      label={translate('agentsPage.moreInformation')}
                      content={translate('agentsPage.environmentVariablesTooltip')}
                    />
                  </>
                }
                description={translate('agentsPage.envHint')}
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      field.handleChange([...field.state.value, { key: '', value: '' }])
                    }
                  >
                    <Plus className="size-3.5" />
                    {translate('agentsPage.addVariable')}
                  </Button>
                }
              >
                {field.state.value.map((entry, i) => (
                  <div key={i} className="mt-2 flex min-w-0 items-center gap-2">
                    <Input
                      aria-label={translate('agentsPage.envKeyPlaceholder')}
                      value={entry.key}
                      placeholder={translate('agentsPage.envKeyPlaceholder')}
                      className="min-w-0 flex-1 font-mono text-sm"
                      onChange={(e) =>
                        field.handleChange(
                          field.state.value.map((v, n) =>
                            n === i ? { ...v, key: e.target.value } : v
                          )
                        )
                      }
                      onBlur={commit}
                      onPaste={(e) => {
                        const pasted = parseEnvAssignmentPaste(e.clipboardData.getData('text'));
                        if (!pasted.length) return;
                        e.preventDefault();
                        field.handleChange(replaceEnvEntryWithPaste(field.state.value, i, pasted));
                      }}
                    />
                    <Input
                      aria-label={translate('agentsPage.envValuePlaceholder')}
                      value={entry.value}
                      placeholder={translate('agentsPage.envValuePlaceholder')}
                      className="min-w-0 flex-1 font-mono text-sm"
                      onChange={(e) =>
                        field.handleChange(
                          field.state.value.map((v, n) =>
                            n === i ? { ...v, value: e.target.value } : v
                          )
                        )
                      }
                      onBlur={commit}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label={translate('agentsPage.removeEnvEntry')}
                      onClick={() => {
                        field.handleChange(field.state.value.filter((_, n) => n !== i));
                        commit();
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </SettingsRow>
            )}
          </form.Field>
        </SettingsGroup>
      </CollapsibleContent>
    </Collapsible>
  );
});

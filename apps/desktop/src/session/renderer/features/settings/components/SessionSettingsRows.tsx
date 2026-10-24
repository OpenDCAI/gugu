import React, { useEffect, useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { invokeOnMachine } from '@renderer/lib/ipc';
import { Input } from '@renderer/lib/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import {
  parseSessionTitleModelOptions,
  SESSION_TITLE_DEFAULT_MODEL,
  SESSION_TITLE_INSTRUCTIONS_MAX,
  SESSION_TITLE_MODELS_CHANNEL,
  type SessionTitleModelOption,
} from '@shared/core/sessions/session-title-namer';
import { useSessionSettings } from '@renderer/features/sessions/hooks/useSessionSettings';
import { DEFAULT_SESSION_AUTO_APPROVE } from '@shared/core/sessions/default-session-autonomy';
import { Switch } from '@/components/ui/Switch';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { DeviceSettingsNotice } from './DeviceSettingsScope';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingsRow } from '@/components/settings/SettingsPrimitives';

export const AutoGenerateSessionNamesRow: React.FC = () => {
  const sessionSettings = useSessionSettings();
  const { translate } = useSessionMessages();

  return (
    <SettingsRow
      title={translate('taskDefaults.autoGenerateName')}
      description={translate('taskDefaults.autoGenerateNameDescription')}
      control={
        <>
          <ResetToDefaultButton
            visible={sessionSettings.isFieldOverridden('autoGenerateName')}
            defaultLabel={translate('reset.on')}
            onReset={sessionSettings.resetAutoGenerateName}
            disabled={sessionSettings.loading || sessionSettings.saving}
          />
          <Switch
            checked={sessionSettings.autoGenerateName}
            disabled={sessionSettings.loading || sessionSettings.saving}
            onCheckedChange={sessionSettings.updateAutoGenerateName}
          />
        </>
      }
    />
  );
};

/** Select 的值不能是 null:「不起名」用一个不会撞上模型 id 的哨兵。 */
const TITLE_MODEL_OFF = '__off__';

/**
 * #7337 用哪个平台模型给新会话起名(按积分计费);「不起名」= 标题留在 harness 起的名或第一句话上。
 * 候选是这个账号此刻在 Chat Completions 上能用的在售模型;档位不够的列出来但不能选。
 */
export const SessionTitleModelRow: React.FC = () => {
  const { value: sessions, update, isLoading: loading, isSaving: saving, isFieldOverridden, resetField } =
    useAppSettingsKey('sessions');
  const { translate } = useSessionMessages();
  const [options, setOptions] = useState<SessionTitleModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    // async 包一层:没有宿主时 invoke 是**同步**抛的(浏览器测试、宿主还没接上),要让它也落进下面的 catch。
    (async () => parseSessionTitleModelOptions(await invokeOnMachine(null, SESSION_TITLE_MODELS_CHANNEL)))()
      .then((models) => {
        if (!cancelled) setOptions(models);
      })
      // 目录取不到(没登录、断网、没有宿主):下拉里只剩当前选的那个与「不起名」,设置照样能改。
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const current = sessions === undefined ? SESSION_TITLE_DEFAULT_MODEL : sessions.titleModel;
  // 能选的排前面,要会员的排后面(各自保持目录里的顺序):免费档一打开就看得到自己能用的那几个。
  const ordered = [
    ...options.filter((option) => !option.requiresMembership),
    ...options.filter((option) => option.requiresMembership),
  ];
  const listed = current && !ordered.some((option) => option.id === current)
    ? [{ id: current, displayName: current, requiresMembership: false }, ...ordered]
    : ordered;
  const labelOf = (value: string) =>
    value === TITLE_MODEL_OFF
      ? translate('taskDefaults.titleModelOff')
      : (listed.find((option) => option.id === value)?.displayName ?? value);
  const defaultLabel = labelOf(SESSION_TITLE_DEFAULT_MODEL);

  return (
    <SettingsRow
      title={translate('taskDefaults.titleModel')}
      description={translate('taskDefaults.titleModelDescription')}
      control={
        <>
          <ResetToDefaultButton
            visible={isFieldOverridden('titleModel')}
            defaultLabel={defaultLabel}
            onReset={() => resetField('titleModel')}
            disabled={loading || saving}
          />
          <Select
            value={current ?? TITLE_MODEL_OFF}
            onValueChange={(next) => update({ titleModel: next === TITLE_MODEL_OFF ? null : String(next) })}
            disabled={loading || saving}
          >
            <SelectTrigger className="w-[220px] shrink-0 gap-2">
              <SelectValue>{labelOf(current ?? TITLE_MODEL_OFF)}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end" className="min-w-max">
              {listed.map((option) => (
                <SelectItem key={option.id} value={option.id} disabled={option.requiresMembership}>
                  <span className="flex items-center gap-2">
                    {option.displayName}
                    {option.requiresMembership ? (
                      <span className="text-xs text-muted-foreground">{translate('taskDefaults.titleModelMembership')}</span>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
              <SelectItem value={TITLE_MODEL_OFF}>{translate('taskDefaults.titleModelOff')}</SelectItem>
            </SelectContent>
          </Select>
        </>
      }
    />
  );
};

/**
 * #7337 起名时追加给模型的风格要求(owner 选 A:只开放追加,不开放整段提示词)。失焦才存,❌ 每敲一个字写一次设置;
 * 选了「不起名」时这一行不可用。
 */
export const SessionTitleInstructionsRow: React.FC = () => {
  const { value: sessions, update, isLoading: loading, isSaving: saving, isFieldOverridden, resetField } =
    useAppSettingsKey('sessions');
  const { translate } = useSessionMessages();
  const instructions = sessions?.titleInstructions ?? '';
  const naming = sessions === undefined || sessions.titleModel !== null;

  return (
    <SettingsRow
      title={translate('taskDefaults.titleInstructions')}
      description={translate('taskDefaults.titleInstructionsDescription')}
      control={
        <>
          <ResetToDefaultButton
            visible={isFieldOverridden('titleInstructions')}
            defaultLabel={translate('taskDefaults.titleInstructionsEmpty')}
            onReset={() => resetField('titleInstructions')}
            disabled={loading || saving}
          />
          <Input
            key={instructions}
            defaultValue={instructions}
            maxLength={SESSION_TITLE_INSTRUCTIONS_MAX}
            placeholder={translate('taskDefaults.titleInstructionsPlaceholder')}
            aria-label={translate('taskDefaults.titleInstructions')}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim();
              if (next !== instructions) update({ titleInstructions: next });
            }}
            disabled={loading || saving || !naming}
            className="w-[220px] shrink-0"
          />
        </>
      }
    />
  );
};

export const AutoApproveByDefaultRow: React.FC = () => {
  const sessionSettings = useSessionSettings();
  const { translate } = useSessionMessages();

  return (
    <SettingsRow
      title={translate('taskDefaults.autoApprove')}
      description={translate('taskDefaults.autoApproveDescription')}
      control={
        <>
          <ResetToDefaultButton
            visible={sessionSettings.isFieldOverridden('autoApproveByDefault')}
            defaultLabel={translate(DEFAULT_SESSION_AUTO_APPROVE ? 'reset.on' : 'reset.off')}
            onReset={sessionSettings.resetAutoApproveByDefault}
            disabled={sessionSettings.loading || sessionSettings.saving}
          />
          <Switch
            checked={sessionSettings.autoApproveByDefault}
            disabled={sessionSettings.loading || sessionSettings.saving}
            onCheckedChange={sessionSettings.updateAutoApproveByDefault}
          />
        </>
      }
    />
  );
};

export const AutoTrustWorktreesRow: React.FC = () => {
  const sessionSettings = useSessionSettings();
  const { translate } = useSessionMessages();

  return (
    <SettingsRow
      title={
        <div className="flex items-center gap-1.5">
          {translate('taskDefaults.autoTrustWorktrees')}
          <InfoTooltip
            label={translate('taskDefaults.autoTrustWorktreesInfoLabel')}
            content={translate('taskDefaults.autoTrustWorktreesInfo')}
          />
        </div>
      }
      description={translate('taskDefaults.autoTrustWorktreesDescription')}
      control={
        <>
          <ResetToDefaultButton
            visible={sessionSettings.isFieldOverridden('autoTrustWorktrees')}
            defaultLabel={translate('reset.on')}
            onReset={sessionSettings.resetAutoTrustWorktrees}
            disabled={sessionSettings.loading || sessionSettings.saving}
          />
          <Switch
            checked={sessionSettings.autoTrustWorktrees}
            disabled={sessionSettings.loading || sessionSettings.saving}
            onCheckedChange={sessionSettings.updateAutoTrustWorktrees}
          />
        </>
      }
    />
  );
};

export const PreserveSessionNameCapitalizationRow: React.FC = () => {
  const sessionSettings = useSessionSettings();
  const { translate } = useSessionMessages();

  return (
    <SettingsRow
      title={translate('taskDefaults.preserveCapitalization')}
      description={translate('taskDefaults.preserveCapitalizationDescription')}
      control={
        <>
          <ResetToDefaultButton
            visible={sessionSettings.isFieldOverridden('preserveNameCapitalization')}
            defaultLabel={translate('reset.off')}
            onReset={sessionSettings.resetPreserveNameCapitalization}
            disabled={sessionSettings.loading || sessionSettings.saving}
          />
          <Switch
            checked={sessionSettings.preserveNameCapitalization}
            disabled={sessionSettings.loading || sessionSettings.saving}
            onCheckedChange={sessionSettings.updatePreserveNameCapitalization}
          />
        </>
      }
    />
  );
};

export const EnableTmuxRow: React.FC = () => {
  const {
    value: projects,
    update,
    isLoading: loading,
    isSaving: saving,
    isFieldOverridden,
    resetField,
    error,
  } = useAppSettingsKey('project');
  const { translate } = useSessionMessages();

  const tmuxByDefault = projects?.tmuxByDefault ?? false;

  return (
    <>
      <SettingsRow
        title={translate('taskDefaults.enableTmux')}
        description={translate('taskDefaults.enableTmuxDescription')}
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('tmuxByDefault')}
              defaultLabel={translate('reset.off')}
              onReset={() => resetField('tmuxByDefault')}
              disabled={loading || saving}
            />
            <Switch
              checked={tmuxByDefault}
              disabled={loading || saving}
              onCheckedChange={(checked) => update({ tmuxByDefault: checked })}
            />
          </>
        }
      />
      <DeviceSettingsNotice error={error} hasData={projects !== undefined} />
    </>
  );
};

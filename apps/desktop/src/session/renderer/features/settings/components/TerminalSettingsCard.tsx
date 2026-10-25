import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { isMacHost } from '@shared/host-os';
import { ChevronsUpDownIcon, Plus } from '@/lib/icons'
import { Minus } from 'lucide-react'
import React, { useCallback, useMemo, useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { cn } from '@renderer/utils/utils';
import { useInstalledFonts } from '@renderer/features/settings/use-installed-fonts';
import { TerminalShellOptionLabel } from '@renderer/lib/components/terminal-shell-option-label';
import {
  DEFAULT_TERMINAL_SHELL_AVAILABILITY,
  useTerminalShellAvailability,
} from '@renderer/lib/hooks/use-terminal-shell-availability';
import { Button } from '@renderer/lib/ui/button';
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxLabel,
  ComboboxTrigger,
  ComboboxValue,
} from '@renderer/lib/ui/combobox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Switch } from '@/components/ui/Switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type TerminalShellId,
} from '@shared/core/terminals/terminal-settings';
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives';

type FontOption = {
  value: string;
  label: string;
};

type FontGroup = {
  value: 'popular' | 'installed';
  label: string;
  items: FontOption[];
};

/**
 * 终端那三格控件(shell 下拉 / 字体下拉 / 字号步进器)共用的一列宽 —— 它们在设置页里排成一条竖线,
 * ❌ 三处各写一遍字面量(改一处就歪一格)。
 *
 * 220px 是**在真机上量出来**的:最长的那条默认标签「默认（JetBrains Mono）」按触发器自己的字
 * (14px/20px Sora)占 168px,加上左右内距(10+10)、右侧箭头(16)与它的间距(8),按钮至少要 214px。
 * 原来的 183px 差 31px,于是那一格**折成两行**、把 36px 高的按钮撑破(owner 2026-09-18 截图圈出)。
 *
 * ⚠️ 量的时候必须用**这个元素自己的 computed font**:界面字是 Sora,比 system-ui 宽 ——
 * 拿 system-ui 估会少算 11px,量完照样截断(我第一版就是这么错的)。
 *
 * 装着的字体名可以任意长,所以宽度之外还有一道兜底:值那一格 `truncate`,长名字省略号收尾,
 * ❌ 永远不折行。
 */
const CONTROL_COLUMN_WIDTH = 'w-[220px]';

// @@@raw font names — 字体族名是系统数据,不本地化;只有分组标题和「默认」外壳是 chrome。
const POPULAR_FONTS = [
  'JetBrains Mono',
  'Menlo',
  'SF Mono',
  'Sarasa Mono SC',
  'Fira Code',
  'Cascadia Code',
  'Iosevka',
  'Source Code Pro',
  'MesloLGS NF',
];

// @@@terminal-cjk-cell (#5586) — 默认这一支是西文的脸;中文由它背后自托管的 Sarasa Mono SC
// 接住(size-adjust 咬着这支的字宽,汉字才正好两格)。换成别的字体会让那个比例出现残差,
// 所以下面那行提示要一直摆在字体选择器旁边。
const DEFAULT_FONT_FAMILY = 'JetBrains Mono';

const clampFontSize = (size: number) =>
  Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, size));

const isMac = isMacHost();

const TerminalSettingsCard: React.FC = () => {
  const {
    value: terminal,
    update,
    isLoading: loading,
    isSaving: saving,
  } = useAppSettingsKey('terminal');
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [query, setQuery] = useState<string>('');
  const { fonts: installedFonts, isLoading: loadingFonts } = useInstalledFonts();
  const { data: localShellAvailability = DEFAULT_TERMINAL_SHELL_AVAILABILITY } =
    useTerminalShellAvailability(undefined);
  const { translate } = useSessionMessages();

  const defaultFontOption = useMemo<FontOption>(
    () => ({
      value: '',
      label: translate('terminal.fontDefaultOption', { fontFamily: DEFAULT_FONT_FAMILY }),
    }),
    [translate]
  );

  const fontFamily = terminal?.fontFamily ?? '';
  const fontSize = terminal?.fontSize ?? TERMINAL_FONT_SIZE_DEFAULT;
  const autoCopyOnSelection = terminal?.autoCopyOnSelection ?? false;
  const macOptionIsMeta = terminal?.macOptionIsMeta ?? false;
  const defaultShell = terminal?.defaultShell ?? 'system';
  const selectedShell = useMemo(
    () =>
      localShellAvailability.find((entry) => entry.id === defaultShell) ?? {
        id: defaultShell,
        label: defaultShell === 'system' ? translate('terminal.shellLoading') : defaultShell,
        isSystemDefault: false,
        available: true,
      },
    [defaultShell, localShellAvailability, translate]
  );

  const groups = useMemo<FontGroup[]>(() => {
    const popularSet = new Set(POPULAR_FONTS.map((f) => f.toLowerCase()));

    const installedSet = new Set(installedFonts.map((font) => font.toLowerCase()));
    const popularItems: FontOption[] = [defaultFontOption];
    for (const font of POPULAR_FONTS) {
      if (installedSet.has(font.toLowerCase())) {
        popularItems.push({ value: font, label: font });
      }
    }

    const installedItems: FontOption[] = [];
    for (const font of installedFonts) {
      const lower = font.toLowerCase();
      if (popularSet.has(lower)) continue;
      installedItems.push({ value: font, label: font });
    }

    return [
      { value: 'popular', label: translate('terminal.fontGroupPopular'), items: popularItems },
      { value: 'installed', label: translate('terminal.fontGroupInstalled'), items: installedItems },
    ];
  }, [defaultFontOption, installedFonts, translate]);

  const visibleGroups = useMemo<FontGroup[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups.filter((group) => group.items.length > 0);
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.label.toLowerCase().includes(q)),
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, query]);

  const selectedOption = useMemo<FontOption | null>(() => {
    if (!fontFamily) return defaultFontOption;
    for (const group of groups) {
      const match = group.items.find((o) => o.value.toLowerCase() === fontFamily.toLowerCase());
      if (match) return match;
    }
    return { value: fontFamily, label: fontFamily };
  }, [defaultFontOption, fontFamily, groups]);

  const applyFont = useCallback(
    (next: string) => {
      const normalized = next.trim();
      update({ fontFamily: normalized });
      window.dispatchEvent(
        new CustomEvent('terminal-font-changed', { detail: { fontFamily: normalized } })
      );
    },
    [update]
  );

  const applyFontSize = useCallback(
    (next: number) => {
      const normalized = clampFontSize(next);
      update({ fontSize: normalized });
      window.dispatchEvent(
        new CustomEvent('terminal-font-changed', { detail: { fontSize: normalized } })
      );
    },
    [update]
  );

  const toggleAutoCopy = useCallback(
    (next: boolean) => {
      update({ autoCopyOnSelection: next });
      window.dispatchEvent(
        new CustomEvent('terminal-auto-copy-changed', { detail: { autoCopyOnSelection: next } })
      );
    },
    [update]
  );

  const toggleMacOptionIsMeta = useCallback(
    (next: boolean) => {
      update({ macOptionIsMeta: next });
      window.dispatchEvent(
        new CustomEvent('terminal-mac-option-is-meta-changed', {
          detail: { macOptionIsMeta: next },
        })
      );
    },
    [update]
  );

  const applyDefaultShell = useCallback(
    (next: TerminalShellId) => {
      update({ defaultShell: next });
    },
    [update]
  );

  return (
    <SettingsGroup>
      <SettingsRow
        title={translate('terminal.defaultShell')}
        description={translate('terminal.defaultShellDescription')}
        control={
          <Select
            value={defaultShell}
            onValueChange={(next) => applyDefaultShell(next as TerminalShellId)}
            disabled={loading || saving}
          >
            <SelectTrigger className={cn(CONTROL_COLUMN_WIDTH, 'shrink-0 gap-2 [&>span]:line-clamp-none')}>
              <SelectValue>
                <TerminalShellOptionLabel entry={selectedShell} showSystemBadge={false} />
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end" className="min-w-max">
              {localShellAvailability.map((entry) => (
                <SelectItem
                  key={entry.id}
                  value={entry.id}
                  disabled={!entry.available}
                  title={entry.reason}
                >
                  <TerminalShellOptionLabel entry={entry} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        title={translate('terminal.font')}
        description={translate('terminal.fontDescription')}
        control={
          <div className={cn(CONTROL_COLUMN_WIDTH, 'flex-shrink-0')}>
            <Combobox
              items={visibleGroups}
              value={selectedOption}
              onValueChange={(opt: FontOption | null) => {
                if (opt) applyFont(opt.value);
              }}
              open={pickerOpen}
              onOpenChange={(open) => {
                setPickerOpen(open);
                if (!open) setQuery('');
              }}
              inputValue={query}
              onInputValueChange={(val: string, { reason }: { reason: string }) => {
                if (reason !== 'item-press') setQuery(val);
              }}
              isItemEqualToValue={(a: FontOption, b: FontOption) => a.value === b.value}
              filter={null}
              autoHighlight
            >
              <ComboboxTrigger
                render={
                  <button
                    type="button"
                    disabled={loading || saving}
                    className="flex h-9 w-full items-center justify-between rounded-md border border-border bg-transparent px-2.5 py-1 text-left text-sm font-normal outline-none disabled:opacity-50"
                  >
                    {/* 单行兜底:装着的字体名可以任意长,长了省略号收尾,❌ 不许折行把 36px 的按钮撑破。 */}
                    <span className="min-w-0 truncate">
                      <ComboboxValue placeholder={defaultFontOption.label} />
                    </span>
                    <ChevronsUpDownIcon className="ml-2 size-4 shrink-0 text-foreground-muted" />
                  </button>
                }
              />
              <ComboboxContent>
                <ComboboxInput
                  showTrigger={false}
                  placeholder={translate('terminal.fontSearchPlaceholder')}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    const typed = e.currentTarget.value.trim();
                    if (!typed) return;
                    e.preventDefault();
                    applyFont(typed);
                    setPickerOpen(false);
                  }}
                />
                <ComboboxList>
                  {(group: FontGroup) => (
                    <ComboboxGroup key={group.value} items={group.items}>
                      <ComboboxLabel>{group.label}</ComboboxLabel>
                      <ComboboxCollection>
                        {(item: FontOption) => (
                          <ComboboxItem key={item.value || '__default__'} value={item}>
                            <span
                              style={{
                                fontFamily: item.value ? `"${item.value}"` : DEFAULT_FONT_FAMILY,
                              }}
                            >
                              {item.label}
                            </span>
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxGroup>
                  )}
                </ComboboxList>
                {loadingFonts ? (
                  <div className="px-1 pb-1">
                    <div className="px-2 py-1.5 text-xs text-foreground-muted">
                      {translate('terminal.fontGroupInstalled')}
                    </div>
                    <div className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-foreground-muted">
                      <LoadingIndicator size="inline" className="shrink-0" />
                      <span className="truncate">{translate('terminal.fontLoading')}</span>
                    </div>
                  </div>
                ) : null}
                <ComboboxEmpty>{translate('terminal.fontEmpty')}</ComboboxEmpty>
              </ComboboxContent>
            </Combobox>
          </div>
        }
      />
      <SettingsRow
        title={translate('terminal.fontSize')}
        control={
          <div className={cn('flex h-9 flex-shrink-0 items-center justify-between rounded-md border border-border bg-background px-1', CONTROL_COLUMN_WIDTH)}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={loading || saving || fontSize <= TERMINAL_FONT_SIZE_MIN}
              onClick={() => applyFontSize(fontSize - 1)}
              aria-label={translate('terminal.fontSizeDecrease')}
            >
              <Minus />
            </Button>
            <div className="flex min-w-14 items-baseline justify-center gap-1 text-sm text-foreground tabular-nums">
              <span>{fontSize}</span>
              <span className="text-foreground-muted text-xs">px</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={loading || saving || fontSize >= TERMINAL_FONT_SIZE_MAX}
              onClick={() => applyFontSize(fontSize + 1)}
              aria-label={translate('terminal.fontSizeIncrease')}
            >
              <Plus />
            </Button>
          </div>
        }
      />
      <SettingsRow
        title={translate('terminal.autoCopy')}
        control={
          <Switch
            checked={autoCopyOnSelection}
            disabled={loading || saving}
            onCheckedChange={toggleAutoCopy}
          />
        }
      />
      {isMac ? (
        <SettingsRow
          title={translate('terminal.optionAsMeta')}
          control={
            <Switch
              checked={macOptionIsMeta}
              disabled={loading || saving}
              onCheckedChange={toggleMacOptionIsMeta}
            />
          }
        />
      ) : null}
    </SettingsGroup>
  );
};

export default TerminalSettingsCard;

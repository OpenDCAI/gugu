import { Check, ChevronDown, Ellipsis, Eraser, Pencil, Plus, Trash2, X } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react';
import { browserControlsRegistry } from '@renderer/features/browser/browser-controls-registry';
import { browserSessionStore } from '@renderer/features/browser/browser-session-store';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Switch } from '@/components/ui/Switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { PRODUCT_NAME } from '@shared/app-identity';
import {
  BROWSER_ISOLATED_PROFILE_ID,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_PROFILES,
  browserProfileLabel,
  isNamedBrowserProfileId,
  normalizeBrowserProfileSelection,
  type BrowserProfile,
  type BrowsingDataKind,
} from '@shared/browser';
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

export function BrowserSettingsCard() {
  const {
    value: browserSettings,
    update,
    updateAsync,
    isLoading,
    isSaving,
  } = useAppSettingsKey('browser');
  const showConfirm = useShowModal('confirmActionModal');
  const { translate } = useSessionMessages();
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isBrowsingDataExpanded, setIsBrowsingDataExpanded] = useState(false);
  const [isClearingBrowsingData, setIsClearingBrowsingData] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const profiles = browserSettings?.profiles ?? DEFAULT_BROWSER_PROFILES;
  const selectedDefault = normalizeBrowserProfileSelection(
    browserSettings?.defaultProfileId,
    profiles
  );
  const disabled = isLoading || isSaving;
  const browsingDataCategories = browsingDataCategoryList(translate);

  const addProfile = (name: string) => {
    setIsAdding(false);
    const nextName = name.trim();
    if (!nextName) return;
    const profile: BrowserProfile = { id: makeProfileId(nextName, profiles), name: nextName };
    update({ profiles: [...profiles, profile] });
  };

  const renameProfile = (profileId: string, name: string) => {
    setEditingProfileId(null);
    const nextName = name.trim();
    if (!nextName) return;
    update({
      profiles: profiles.map((profile) =>
        profile.id === profileId ? { ...profile, name: nextName } : profile
      ),
    });
  };

  const clearProfileStorage = (profile: BrowserProfile) => {
    showConfirm({
      title: translate('browserSettings.clearProfileStorageTitle', { name: profile.name }),
      description: translate('browserSettings.clearProfileStorageDescription'),
      confirmLabel: translate('browserSettings.clearProfileStorageAction'),
      variant: 'destructive',
      onSuccess: () => {
        void clearProfileStorageAndReload(profile.id, translate);
      },
    });
  };

  const runClearBrowsingData = async (kind: BrowsingDataKind, label: string) => {
    setIsClearingBrowsingData(true);
    try {
      const result = await rpc.browser.clearBrowsingData(kind);
      if (!result.success) {
        toast({
          title: translate('browserSettings.clearBrowsingDataFailed'),
          description: translate('browserSettings.clearBrowsingDataFailedHint'),
          variant: 'destructive',
        });
        return;
      }
      reloadAllBrowserSessions();
      toast({ title: translate('browserSettings.clearedToast', { label }) });
    } catch (error) {
      toast({
        title: translate('browserSettings.clearBrowsingDataFailed'),
        // @@@raw detail — 未知错误原文不改写。
        description: errorMessage(error),
        variant: 'destructive',
      });
    } finally {
      setIsClearingBrowsingData(false);
    }
  };

  const clearBrowsingData = (kind: BrowsingDataKind, label: string) => {
    showConfirm({
      ...browsingDataConfirmation(translate, kind),
      variant: 'destructive',
      onSuccess: () => {
        void runClearBrowsingData(kind, label);
      },
    });
  };

  const deleteProfile = (profile: BrowserProfile) => {
    if (profiles.length <= 1) return;
    showConfirm({
      title: translate('browserSettings.deleteProfileTitle', { name: profile.name }),
      description: translate('browserSettings.deleteProfileDescription'),
      confirmLabel: translate('browserSettings.deleteProfileAction'),
      variant: 'destructive',
      onSuccess: () => {
        const nextProfiles = profiles.filter((candidate) => candidate.id !== profile.id);
        const replacementProfileId =
          selectedDefault === profile.id
            ? (nextProfiles[0]?.id ?? DEFAULT_BROWSER_PROFILE_ID)
            : selectedDefault;
        void deleteProfileAfterStorageClear({
          deletedProfileId: profile.id,
          replacementProfileId,
          nextProfiles,
          updateAsync,
          translate,
        });
      },
    });
  };

  return (
    <>
      <SettingsGroup>
      <SettingsRow
        title={translate('browserSettings.defaultProfile')}
        description={translate('browserSettings.defaultProfileDescription')}
        control={
          <Select
            value={selectedDefault}
            onValueChange={(next) => {
              if (next) update({ defaultProfileId: next });
            }}
            disabled={disabled}
          >
            <SelectTrigger className="w-[190px] shrink-0 gap-2">
              <SelectValue>{browserProfileLabel(selectedDefault, profiles)}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              {/* @@@raw profile name — 浏览器配置名是用户数据,原样显示。 */}
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
              <SelectItem value={BROWSER_ISOLATED_PROFILE_ID}>
                {translate('browserSettings.isolatedPerTask')}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />

      <ImportLoginsRow
        profileId={isNamedBrowserProfileId(selectedDefault) ? selectedDefault : null}
        profileName={browserProfileLabel(selectedDefault, profiles)}
        disabled={disabled}
      />

      <SettingsRow
        title={translate('browserSettings.relaxCors')}
        description={translate('browserSettings.relaxCorsDescription', { appName: PRODUCT_NAME })}
        control={
          <Switch
            checked={browserSettings?.relaxCorsForLocalhost ?? false}
            disabled={disabled}
            onCheckedChange={(next) => update({ relaxCorsForLocalhost: next })}
          />
        }
      />

      </SettingsGroup>

      {/* 配置列表与浏览数据:一项一行,用设置弹窗那一种行(product spec)。 */}
      <SettingsGroup
        title={translate('browserSettings.profiles')}
        note={translate('browserSettings.profilesDescription')}
      >
          {profiles.map((profile) => (
            <SettingsRow key={profile.id}>
            <div className="flex min-h-7 items-center gap-2">
              {editingProfileId === profile.id ? (
                <>
                  <Input
                    ref={renameInputRef}
                    autoFocus
                    defaultValue={profile.name}
                    disabled={disabled}
                    aria-label={translate('browserSettings.renameProfileLabel', {
                      name: profile.name,
                    })}
                    className="h-7 min-w-0 flex-1"
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter')
                        renameProfile(profile.id, event.currentTarget.value);
                      if (event.key === 'Escape') setEditingProfileId(null);
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-foreground-muted"
                    disabled={disabled}
                    aria-label={translate('browserSettings.saveProfileNameLabel', {
                      name: profile.name,
                    })}
                    onClick={() => renameProfile(profile.id, renameInputRef.current?.value ?? '')}
                  >
                    <Check className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-foreground-muted"
                    disabled={disabled}
                    aria-label={translate('browserSettings.cancelRenameLabel', {
                      name: profile.name,
                    })}
                    onClick={() => setEditingProfileId(null)}
                  >
                    <X className="size-4" />
                  </Button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {profile.name}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0 text-foreground-muted"
                          disabled={disabled}
                          aria-label={translate('browserSettings.profileActionsLabel', {
                            name: profile.name,
                          })}
                        />
                      }
                    >
                      <Ellipsis className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="min-w-40"
                      finalFocus={renameInputRef}
                    >
                      <DropdownMenuItem onClick={() => setEditingProfileId(profile.id)}>
                        <Pencil className="size-4" />
                        {translate('browserSettings.rename')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => clearProfileStorage(profile)}>
                        <Eraser className="size-4" />
                        {translate('browserSettings.clearStorage')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={profiles.length <= 1}
                        onClick={() => deleteProfile(profile)}
                      >
                        <Trash2 className="size-4" />
                        {translate('browserSettings.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
            </SettingsRow>
          ))}

        <SettingsRow>
        <div className="flex min-h-7 items-center">
          {isAdding ? (
            <div className="flex w-full items-center gap-2">
              <Input
                ref={addInputRef}
                autoFocus
                disabled={disabled}
                placeholder={translate('browserSettings.newProfilePlaceholder')}
                aria-label={translate('browserSettings.newProfileLabel')}
                className="h-7 min-w-0 flex-1"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') addProfile(event.currentTarget.value);
                  if (event.key === 'Escape') setIsAdding(false);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-foreground-muted"
                disabled={disabled}
                aria-label={translate('browserSettings.saveNewProfile')}
                onClick={() => addProfile(addInputRef.current?.value ?? '')}
              >
                <Check className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-foreground-muted"
                disabled={disabled}
                aria-label={translate('browserSettings.cancelAddProfile')}
                onClick={() => setIsAdding(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-foreground-muted"
              disabled={disabled}
              onClick={() => setIsAdding(true)}
            >
              <Plus className="size-4" />
              {translate('browserSettings.addProfile')}
            </Button>
          )}
        </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          title={translate('browserSettings.browsingData')}
          description={translate('browserSettings.browsingDataDescription')}
          control={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-foreground-muted"
              disabled={disabled || isClearingBrowsingData}
              onClick={() =>
                clearBrowsingData('all', translate('browserSettings.clearAllBrowsingData'))
              }
            >
              {translate('browserSettings.clearAllBrowsingData')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground-muted"
              aria-expanded={isBrowsingDataExpanded}
              aria-label={
                isBrowsingDataExpanded
                  ? translate('browserSettings.hideBrowsingDataOptions')
                  : translate('browserSettings.showBrowsingDataOptions')
              }
              onClick={() => setIsBrowsingDataExpanded((expanded) => !expanded)}
            >
              <ChevronDown
                className={cn(
                  'size-4 transition-transform',
                  isBrowsingDataExpanded && 'rotate-180'
                )}
              />
            </Button>
          </>
          }
        />

        {isBrowsingDataExpanded &&
            browsingDataCategories.map((category) => (
              <SettingsRow
                key={category.kind}
                title={category.label}
                control={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-foreground-muted"
                  disabled={disabled || isClearingBrowsingData}
                  onClick={() => clearBrowsingData(category.kind, category.label)}
                >
                  {category.actionLabel}
                </Button>
                }
              />
            ))}
      </SettingsGroup>
    </>
  );
}

function browsingDataCategoryList(translate: Translate): ReadonlyArray<{
  kind: Exclude<BrowsingDataKind, 'all'>;
  label: string;
  actionLabel: string;
}> {
  return [
    {
      kind: 'cookies',
      label: translate('browserSettings.categoryCookies'),
      actionLabel: translate('browserSettings.categoryCookiesAction'),
    },
    {
      kind: 'siteData',
      label: translate('browserSettings.categorySiteData'),
      actionLabel: translate('browserSettings.categorySiteDataAction'),
    },
    {
      kind: 'cache',
      label: translate('browserSettings.categoryCache'),
      actionLabel: translate('browserSettings.categoryCacheAction'),
    },
  ];
}

function browsingDataConfirmation(
  translate: Translate,
  kind: BrowsingDataKind
): { title: string; description: string; confirmLabel: string } {
  switch (kind) {
    case 'all':
      return {
        title: translate('browserSettings.confirmAllTitle'),
        description: translate('browserSettings.confirmAllDescription'),
        confirmLabel: translate('browserSettings.confirmAllAction'),
      };
    case 'cookies':
      return {
        title: translate('browserSettings.confirmCookiesTitle'),
        description: translate('browserSettings.confirmCookiesDescription'),
        confirmLabel: translate('browserSettings.categoryCookiesAction'),
      };
    case 'siteData':
      return {
        title: translate('browserSettings.confirmSiteDataTitle'),
        description: translate('browserSettings.confirmSiteDataDescription'),
        confirmLabel: translate('browserSettings.categorySiteDataAction'),
      };
    case 'cache':
      return {
        title: translate('browserSettings.confirmCacheTitle'),
        description: translate('browserSettings.confirmCacheDescription'),
        confirmLabel: translate('browserSettings.confirmCacheAction'),
      };
  }
}

/**
 * #7191「从默认浏览器导入登录」:一个按钮、一次全量(owner 2026-10-15「懒人式,一次性导入」,❌ 列站点让人勾)。
 * 导进**默认配置**;要登另一个账号就把默认配置换成另一份再导一次。导完刷新开着的页签,登录态立刻生效。
 */
function ImportLoginsRow({
  profileId,
  profileName,
  disabled,
}: {
  /** 导进哪份配置;默认是「每个任务独立」时没有固定的那一份 = null。 */
  profileId: string | null;
  profileName: string;
  disabled: boolean;
}) {
  const { translate } = useSessionMessages();
  const [browser, setBrowser] = useState<{ name: string; supported: boolean } | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void rpc.browser.defaultBrowser().then((found) => {
      if (!cancelled) setBrowser(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const name = browser?.name || translate('browserSettings.importLoginsUnknownBrowser');
  const runImport = async () => {
    if (!profileId) return;
    setImporting(true);
    toast({ title: translate('browserSettings.importingToast', { browser: name }) });
    try {
      const result = await rpc.browser.importDefaultBrowserCookies(profileId);
      if (result.ok) {
        reloadAllBrowserSessions();
        // 只读出一部分(其余被锁着 / 没授权)要说清,❌ 只报「导入了 N 条」让人以为全导了。
        const notes = [
          ...(result.partial
            ? [`${translate('browserSettings.importedPartial')}${translate(`browserSettings.importFailedReason.${result.partial}`, { browser: name })}`]
            : []),
          ...(result.skipped > 0 ? [translate('browserSettings.importedSkipped', { count: result.skipped })] : []),
        ];
        toast({
          title: translate('browserSettings.importedToast', { browser: name, count: result.imported, profile: profileName }),
          ...(notes.length > 0 ? { description: notes.join(' ') } : {}),
        });
        return;
      }
      toast({
        title: translate('browserSettings.importFailed', { browser: name }),
        description: translate(`browserSettings.importFailedReason.${result.reason}`, { browser: name }),
        variant: 'destructive',
      });
    } finally {
      setImporting(false);
    }
  };

  const unavailable = !browser || !browser.supported || !profileId;
  return (
    <SettingsRow
      title={translate('browserSettings.importLogins')}
      description={
        !profileId
          ? translate('browserSettings.importLoginsNeedsProfile')
          : browser && !browser.supported
            ? translate(browser.name ? 'browserSettings.importLoginsUnsupported' : 'browserSettings.importLoginsNoBrowser', { browser: browser.name })
            : translate('browserSettings.importLoginsDescription', { browser: name, profile: profileName })
      }
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={disabled || importing || unavailable}
          onClick={() => void runImport()}
        >
          {importing
            ? translate('browserSettings.importingAction')
            : translate('browserSettings.importLoginsAction', { browser: name })}
        </Button>
      }
    />
  );
}

function reloadAllBrowserSessions(): void {
  for (const session of browserSessionStore.activeSessions) {
    browserControlsRegistry.get(session.browserId)?.adapter?.reload();
  }
}

async function clearProfileStorageAndReload(
  profileId: string,
  translate: Translate
): Promise<void> {
  try {
    const result = await rpc.browser.clearProfileStorage(profileId);
    if (!result.success) {
      toast({
        title: translate('browserSettings.clearProfileStorageFailed'),
        description: translate('browserSettings.clearProfileStorageMissing'),
        variant: 'destructive',
      });
      return;
    }
    reloadBrowserSessionsForProfile(profileId);
  } catch (error) {
    toast({
      title: translate('browserSettings.clearProfileStorageFailed'),
      description: errorMessage(error),
      variant: 'destructive',
    });
  }
}

async function deleteProfileAfterStorageClear({
  deletedProfileId,
  replacementProfileId,
  nextProfiles,
  updateAsync,
  translate,
}: {
  deletedProfileId: string;
  replacementProfileId: string;
  nextProfiles: BrowserProfile[];
  updateAsync: (partial: { profiles: BrowserProfile[]; defaultProfileId: string }) => Promise<void>;
  translate: Translate;
}): Promise<void> {
  let storageCleared = false;
  try {
    const clearResult = await rpc.browser.clearProfileStorage(deletedProfileId);
    if (!clearResult.success) {
      toast({
        title: translate('browserSettings.deleteProfileFailed'),
        description: translate('browserSettings.deleteProfileKept'),
        variant: 'destructive',
      });
      return;
    }

    storageCleared = true;
    await updateAsync({
      profiles: nextProfiles,
      defaultProfileId: replacementProfileId,
    });
    browserSessionStore.migrateProfileSessions(
      deletedProfileId,
      replacementProfileId,
      nextProfiles
    );
  } catch (error) {
    if (storageCleared) reloadBrowserSessionsForProfile(deletedProfileId);
    toast({
      title: translate('browserSettings.deleteProfileFailed'),
      description: storageCleared
        ? translate('browserSettings.deleteProfileStillListed', { detail: errorMessage(error) })
        : errorMessage(error),
      variant: 'destructive',
    });
  }
}

function reloadBrowserSessionsForProfile(profileId: string): void {
  for (const session of browserSessionStore.activeSessions) {
    if (session.profileId !== profileId) continue;
    browserControlsRegistry.get(session.browserId)?.adapter?.reload();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeProfileId(name: string, profiles: readonly BrowserProfile[]): string {
  const existingIds = new Set(profiles.map((profile) => profile.id));
  const base = slugifyProfileName(name) || 'profile';
  let candidate = base;
  let suffix = 2;
  while (existingIds.has(candidate) || !isNamedBrowserProfileId(candidate)) {
    const suffixText = String(suffix);
    const prefixLength = Math.max(1, 63 - suffixText.length);
    candidate = `${base.slice(0, prefixLength)}-${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

function slugifyProfileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

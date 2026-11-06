import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { Button } from '@renderer/lib/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/lib/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/lib/ui/dropdown-menu';
import type { HostDependencyInstallation } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AgentPayload, Installation } from '@shared/core/agents/agent-payload';
import { InstallProgressRow } from './InstallProgressRow';
import { installFailureSummary } from './install-failure-summary';

export type SourceKind = 'local' | 'managed' | 'custom';
export type AgentSourceListProps = {
  vm: HostDependencyInstallation;
  agentPayload: AgentPayload | undefined;
  inUse: SourceKind | null;
  local: Installation | undefined;
  managed: Installation | undefined;
  custom: Installation | undefined;
  canInstall: boolean;
  canUninstall: boolean;
  installDocs?: string | null;
  onSelect: (kind: SourceKind) => void;
  onInstall: () => void;
  onUpdate: (() => void) | undefined;
  onOpenCustom: () => void;
  customEditor: ReactNode | undefined;
};

/** Installation is always first; source selection never pretends an absent copy is active. */
export const AgentSourceList = observer(function AgentSourceList({
  vm,
  agentPayload,
  inUse,
  local,
  managed,
  custom,
  canInstall,
  canUninstall,
  installDocs,
  onSelect,
  onInstall,
  onUpdate,
  onOpenCustom,
  customEditor
}: AgentSourceListProps) {
  const { translate } = useSessionMessages();
  const busy = vm.isInstalling || vm.isUpdating || vm.isUninstalling;
  const lastFailure = vm.lastInstallError ?? vm.lastUpdateError;
  const failure = lastFailure && installFailureSummary(lastFailure, translate, !vm.lastInstallError);
  const active = inUse === 'managed' ? managed : inUse === 'custom' ? custom : local;
  const available = active?.status === 'available';
  const companions = vm.data?.programs?.slice(1) ?? [];
  const companionMissing = companions.some((p) => !p.managed);
  const companionUpdate = companions.some((p) => p.managedUpdateAvailable);
  const needsUpdate = !!active?.updateAvailable || companionUpdate;
  const managedUpdate = inUse === 'managed' && onUpdate;
  const installLabel = translate(
    local || custom ? 'agentsPage.installAndSwitch' : 'agentsPage.installWithManaged'
  );
  const onSelectSource = (value: unknown) => {
    if (value === 'custom') {
      if (custom?.status === 'available' && inUse !== 'custom') onSelect('custom');
      else onOpenCustom();
    } else if (value === 'managed' && !managed) onInstall();
    else if (value === 'local' || value === 'managed') onSelect(value);
  };
  const uninstall = () => {
    const name = agentPayload?.name ?? translate('agentsPage.agentFallbackName');
    void toast.promise(vm.uninstall(), {
      loading: translate('agentsPage.uninstalling', { name }),
      success: translate('agentsPage.uninstalled', { name }),
      error: (error) => {
        rendererLogger('actions/AgentSourceList').error({ error }, 'action failed');
        return messageForUser(error);
      }
    });
  };
  let description: ReactNode = translate(
    available ? 'agentsPage.installed' : 'agentsPage.notInstalled'
  );
  if (active)
    description = (
      <>
        {translate(
          active.status === 'available' ? 'agentsPage.installed' : active.status === 'error' ? 'agentsPage.stateBroken' : 'agentsPage.notInstalled'
        )}
        {available && active.version && ` v${active.version}`}
        {needsUpdate && (
          <>
            {' '}
            · {translate('agentsPage.updateAvailable')}
            {active.latestVersion && ` v${active.latestVersion}`}
          </>
        )}
      </>
    );
  if (failure && !busy)
    description = <span className="text-foreground-destructive">{failure.message}</span>;
  const action =
    failure && (canInstall || onUpdate) ? (
      <Button
        size="sm"
        variant="outline"
        onClick={!vm.lastInstallError && vm.lastUpdateError && onUpdate ? onUpdate : onInstall}
        disabled={busy || (!canInstall && !onUpdate)}
      >
        {translate(!vm.lastInstallError && vm.lastUpdateError && onUpdate ? 'agentsPage.updateAction' : 'agentsPage.reinstall')}
      </Button>
    ) : (!available && canInstall) || (companionMissing && canInstall) ? (
      <Button size="sm" variant="outline" onClick={onInstall} disabled={busy}>
        {installLabel}
      </Button>
    ) : needsUpdate && (managedUpdate || canInstall) ? (
      <Button size="sm" variant="outline" onClick={managedUpdate || onInstall} disabled={busy}>
        {managedUpdate
          ? translate('agentsPage.updateAction')
          : translate('agentsPage.installAndSwitch')}
      </Button>
    ) : !canInstall && !available && installDocs ? (
      <a
        href={installDocs}
        target="_blank"
        rel="noreferrer"
        className="text-sm underline underline-offset-2"
      >
        {translate('agentsPage.installDocsLink')}
      </a>
    ) : null;
  return (
    <SettingsGroup>
      <SettingsRow
        title={translate('agentsPage.installation')}
        description={vm.isInstalling || vm.isUpdating ? undefined : description}
        data-testid="agent-installation-row"
        control={
          !vm.isInstalling && !vm.isUpdating ? (
            <>
              {action}
              {canUninstall && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        aria-label={translate('agentsPage.installOptions')}
                        disabled={busy}
                      />
                    }
                  >
                    ⋯
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={uninstall} disabled={busy}>
                      {translate('agentsPage.uninstallAction')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          ) : undefined
        }
      >
        {vm.isInstalling || vm.isUpdating ? (
          <InstallProgressRow
            progress={vm.installProgress}
            onCancel={() => void vm.cancelInstall()}
            compact
          />
        ) : (
          <>
            {failure?.diagnostic && (
              <details className="mt-1 text-xs text-foreground-muted">
                <summary className="cursor-pointer">{translate('agentsPage.errorDetails')}</summary>
                <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all">
                  {failure.diagnostic}
                </pre>
              </details>
            )}
            {!failure && needsUpdate && inUse !== 'managed' && canInstall && (
              <p className="m-0 text-xs text-foreground-muted">
                {translate('agentsPage.managedNoteAbsent')}
              </p>
            )}
            {companions.map((p) => (
              <p key={p.dependencyId} className="m-0 text-xs text-foreground-muted">
                {p.name} ·{' '}
                {p.managedVersion ? `v${p.managedVersion}` : translate('agentsPage.notInstalled')}
              </p>
            ))}
          </>
        )}
      </SettingsRow>
      {!vm.isInstalling && !vm.isUpdating && (
        <SettingsRow
          title={translate('agentsPage.sourceHeading')}
          description={
            <span title={active?.pathEntry ?? active?.realpath ?? undefined}>
              {inUse === 'local'
                ? translate('agentsPage.sourceLocalDescription')
                : inUse === 'managed'
                  ? translate('agentsPage.sourceManagedDescription')
                  : custom?.pathEntry}
            </span>
          }
          control={
            <>
              {inUse === 'custom' && !customEditor && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="manual-override-open"
                  onClick={onOpenCustom}
                >
                  {translate('agentsPage.customEdit')}
                </Button>
              )}
              <Select value={inUse ?? 'managed'} onValueChange={onSelectSource} disabled={busy}>
                <SelectTrigger
                  className="w-[156px]"
                  aria-label={translate('agentsPage.sourceHeading')}
                >
                  <SelectValue>
                    {translate(
                      inUse === 'local'
                        ? 'agentsPage.sourceLocal'
                        : inUse === 'custom'
                          ? 'agentsPage.sourceCustom'
                          : 'agentsPage.sourceManaged'
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  {local && (
                    <SelectItem value="local">
                      <span>{translate('agentsPage.sourceLocal')}</span>
                      <span className="text-xs text-foreground-muted">
                        {local.provenance.kind} · {local.pathEntry ?? local.realpath}
                      </span>
                    </SelectItem>
                  )}
                  {(managed || canInstall) && (
                    <SelectItem value="managed">{translate('agentsPage.sourceManaged')}</SelectItem>
                  )}
                  <SelectItem value="custom">
                    <span>{translate('agentsPage.sourceCustom')}</span>
                    {custom?.pathEntry && (
                      <span className="text-xs text-foreground-muted">{custom.pathEntry}</span>
                    )}
                  </SelectItem>
                </SelectContent>
              </Select>
            </>
          }
        >
          {customEditor}
        </SettingsRow>
      )}
    </SettingsGroup>
  );
});

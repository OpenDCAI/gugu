import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'

import { observer } from 'mobx-react-lite';
import type { KeyboardEvent, ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@renderer/lib/ui/button';
import type { HostDependencyInstallation } from '@renderer/lib/stores/use-agent-installation-statuses';
import { readingLabelKey } from '@renderer/lib/components/agent-availability-groups';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import type { AgentPayload, Installation } from '@shared/core/agents/agent-payload';
import { InstallProgressRow } from './InstallProgressRow';

export type SourceKind = 'local' | 'managed' | 'custom';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

/** 「谁装的」—— 本机找到的那份要说得出它是怎么来的(owner 2026-09-22)。 */
function provenanceLabel(translate: Translate, inst: Installation): string {
  switch (inst.provenance.kind) {
    case 'homebrew':
      return 'Homebrew';
    case 'npm':
      return 'npm';
    case 'winget':
      return 'winget';
    case 'apt':
      return 'apt';
    case 'curl':
      return translate('agentsPage.viaInstallScript');
    case 'version-manager':
      return translate('agentsPage.viaVersionManager');
    default:
      return translate('agentsPage.viaUnknown');
  }
}

export type AgentSourceListProps = {
  vm: HostDependencyInstallation;
  agentPayload: AgentPayload | undefined;
  /** 现在运行时真会跑的是哪一种;一份都没有就是 null。 */
  inUse: SourceKind | null;
  local: Installation | undefined;
  managed: Installation | undefined;
  custom: Installation | undefined;
  /** 这一家咕咕装得了吗(有托管安装)。 */
  canInstall: boolean;
  canUninstall: boolean;
  installDocs?: string | null;
  onSelect: (kind: SourceKind) => void;
  onInstall: () => void;
  /** 咕咕那份有新版本时的原地更新;没有就是 undefined。 */
  onUpdate: (() => void) | undefined;
  onOpenCustom: () => void;
  /** 「自定义路径」那一行展开时的输入卡。 */
  customEditor: ReactNode | undefined;
};

/**
 * 「用哪一份」—— 一家智能体的来源只有三种,面板就按这三种排(owner 2026-09-22):
 *
 * 1. **本机找到的**:咕咕在这台机器上嗅探到的、用户自己装的那一份。说清版本、谁装的、在哪,
 *    并且**明说咕咕不管它** —— 所以这一行没有更新和卸载。❌ 不再藏起来只写「已安装」:owner
 *    看不出为什么没有更新、没有卸载,以为是坏了。
 * 2. **咕咕管理**:咕咕自己装的那一份,能更新、能卸载。没装时按钮是「安装」;本机已有别的
 *    一份时是「安装并切换」—— 这就是「从别处装的迁到咕咕管理」的那条路,原来那份不动。
 * 3. **自定义路径**:用户指定的程序或命令(比如 `reclaude` 这类 wrapper)。
 *
 * 点一行 = 切到那一份(它得真的存在)。在用的那一行圆点是实心的,并写着「在用」。
 */
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
  customEditor,
}: AgentSourceListProps) {
  const { translate } = useSessionMessages();
  const busy = vm.isInstalling || vm.isUpdating || vm.isUninstalling;
  const failure = vm.lastInstallError ?? vm.lastUpdateError;
  const retry = vm.lastInstallError ? onInstall : onUpdate;
  const mono = (v: string) => <span className="font-mono text-[0.95em]">v{v}</span>;
  /**
   * 这一家另外几条腿跑的程序(#6335:Antigravity 终端腿的 `agy`)。「咕咕管理」装的是**一整套**:
   * 任何一个程序还没有咕咕那一份,安装按钮就还在(点下去只补缺的那个);有新版本的那个由「更新」带走。
   */
  const companions = vm.data?.programs?.slice(1) ?? [];
  const companionMissing = companions.some((program) => !program.managed);
  const companionUpdate = companions.some((program) => program.managedUpdateAvailable);
  const broken = (inst: Installation | undefined) =>
    inst && inst.status !== 'available' ? (
      <span className="text-foreground-warning">{translate(readingLabelKey('detected-but-broken'))}</span>
    ) : null;
  const managedNote = managed ? broken(managed)
    : !canInstall ? translate('agentsPage.managedUnavailable')
    : local || custom ? translate('agentsPage.managedNoteAbsent') : null;

  const uninstall = () => {
    // @@@raw agent name — agent 名是 provider 数据,只做插值。
    const name = agentPayload?.name ?? translate('agentsPage.agentFallbackName');
    void toast.promise(vm.uninstall(), {
      loading: translate('agentsPage.uninstalling', { name }),
      success: translate('agentsPage.uninstalled', { name }),
      error: () => translate('agentsPage.uninstallFailed', { name }),
    });
  };

  return (
    <div className="flex flex-col pb-3" role="radiogroup" aria-label={translate('agentsPage.sourceHeading')}>
      <p className="m-0 pb-1 text-sm text-foreground-muted">{translate('agentsPage.sourceHeading')}</p>

      {/* 1 · 本机找到的 */}
      <SourceRow
        testId="source-row-local"
        title={translate('agentsPage.sourceLocal')}
        inUse={inUse === 'local'}
        selectable={!!local && inUse !== 'local'}
        onSelect={() => onSelect('local')}
        value={local?.version ? mono(local.version) : local ? null : (
          <span className="text-foreground-muted">{translate('agentsPage.sourceNotFound')}</span>
        )}
        inUseLabel={translate('agentsPage.sourceInUse')}
        detail={local && (
          <>
            <p className="m-0 truncate text-sm text-foreground-muted" title={local.pathEntry ?? local.realpath}>
              {provenanceLabel(translate, local)} ·{' '}
              <span className="font-mono text-[0.9em]">{local.pathEntry ?? local.realpath}</span>
            </p>
            <p className="m-0 text-sm text-foreground-muted">
              {broken(local) ?? translate('agentsPage.localNote')}
              {local.updateAvailable && local.latestVersion && canInstall && !managed && (
                <> {translate('agentsPage.localNewer', { version: local.latestVersion })}</>
              )}
            </p>
          </>
        )}
      />

      {/* 2 · 咕咕管理 */}
      <SourceRow
        testId="source-row-managed"
        title={translate('agentsPage.sourceManaged')}
        inUse={inUse === 'managed'}
        selectable={!!managed && inUse !== 'managed' && !busy}
        onSelect={() => onSelect('managed')}
        value={
          managed?.version ? (
            <>
              {mono(managed.version)}
              {managed.updateAvailable && managed.latestVersion && (
                <span className="text-foreground-muted">
                  {' · '}
                  {translate('agentsPage.updateAvailable')} {mono(managed.latestVersion)}
                </span>
              )}
            </>
          ) : managed ? null : (
            <span className="text-foreground-muted">{translate('agentsPage.notInstalled')}</span>
          )
        }
        inUseLabel={translate('agentsPage.sourceInUse')}
        actions={
          <>
            {(!managed || companionMissing) && canInstall && !vm.isInstalling && (
              <Button size="sm" disabled={busy} onClick={onInstall} data-testid="source-managed-install">
                {translate(local || custom ? 'agentsPage.installAndSwitch' : 'agentsPage.installWithManaged')}
              </Button>
            )}
            {managed && (managed.updateAvailable || companionUpdate) && onUpdate && !vm.isUpdating && (
              <Button size="sm" disabled={busy} onClick={onUpdate} data-testid="source-managed-update">
                {translate('agentsPage.updateAction')}
              </Button>
            )}
            {managed && canUninstall && (
              <Button size="sm" variant="outline" disabled={busy} onClick={uninstall} data-testid="source-managed-uninstall">
                {vm.isUninstalling && <LoadingIndicator size="inline" />}
                {translate('agentsPage.uninstallAction')}
              </Button>
            )}
          </>
        }
        detail={
          vm.isInstalling || vm.isUpdating || failure ? undefined : (
            <>
              {/* 另几个程序各一行:名字 · 二进制名 · 咕咕那一份的版本(或未安装)。
                  名字是 provider 数据,只做插值。 */}
              {companions.map((program) => (
                <p
                  key={program.dependencyId}
                  data-testid={`source-managed-program-${program.dependencyId}`}
                  className="m-0 truncate text-sm text-foreground-muted"
                >
                  {program.name} · <span className="font-mono text-[0.9em]">{program.binaryName}</span> ·{' '}
                  {program.managedVersion ? mono(program.managedVersion) : translate('agentsPage.notInstalled')}
                </p>
              ))}
              {managedNote && <p className="m-0 text-sm text-foreground-muted">{managedNote}</p>}
            </>
          )
        }
        extra={
          vm.isInstalling || vm.isUpdating ? (
            <div className="pt-1">
              <InstallProgressRow progress={vm.installProgress} onCancel={() => void vm.cancelInstall()} />
            </div>
          ) : failure ? (
            <div className="flex items-center gap-3 pt-1">
              <p className="m-0 min-w-0 text-sm text-foreground-destructive">{failure.message}</p>
              {retry && (
                <Button size="sm" variant="outline" className="ml-auto shrink-0" disabled={busy} onClick={retry}>
                  {translate('agentsPage.retry')}
                </Button>
              )}
            </div>
          ) : !managed && !canInstall && installDocs ? (
            <a href={installDocs} target="_blank" rel="noreferrer" className="text-sm text-foreground underline underline-offset-2">
              {translate('agentsPage.installDocsLink')}
            </a>
          ) : undefined
        }
      />

      {/* 3 · 自定义路径 */}
      <SourceRow
        testId="source-row-custom"
        title={translate('agentsPage.sourceCustom')}
        inUse={inUse === 'custom'}
        selectable={!!custom && custom.status === 'available' && inUse !== 'custom'}
        onSelect={() => onSelect('custom')}
        value={custom?.version ? mono(custom.version) : null}
        inUseLabel={translate('agentsPage.sourceInUse')}
        actions={
          !customEditor && (
            <Button size="sm" variant="outline" onClick={onOpenCustom} data-testid="manual-override-open">
              {translate(custom ? 'agentsPage.customEdit' : 'agentsPage.sourceSpecify')}
            </Button>
          )
        }
        detail={
          customEditor ? undefined : (
            <p className="m-0 truncate text-sm text-foreground-muted" title={custom?.pathEntry ?? undefined}>
              {custom ? (
                <>
                  <span className="font-mono text-[0.9em]">{custom.pathEntry}</span>
                  {custom.status !== 'available' && <> · {translate('agentsPage.customMissing')}</>}
                </>
              ) : (
                translate('agentsPage.customNoteEmpty')
              )}
            </p>
          )
        }
        extra={customEditor}
      />
    </div>
  );
});

/**
 * 一行来源。
 *
 * 只有左边「圆点 + 文字」那一块是可点的单选项(切到这一份);右边的按钮和下面展开的输入格 /
 * 进度 / 重试是它的**兄弟**,不在单选项里面。
 * ❌ 不把按钮塞进 role="radio" 里:单选项不可选时带 aria-disabled,读屏与自动化会把里面的按钮
 * 一起当成禁用(真机取证时「指定…」点不动,就是这个)。
 * ❌ 也不给行加负外边距去做悬停底色:弹窗内容区是一个滚动容器,溢出一点就会横向滚动,
 * 左边的字被切掉(owner 截图里「高级设置」那一片就是这样)。
 */
function SourceRow({
  testId,
  title,
  value,
  inUse,
  inUseLabel,
  selectable,
  onSelect,
  actions,
  detail,
  extra,
}: {
  testId: string;
  title: string;
  value?: ReactNode;
  inUse: boolean;
  inUseLabel: string;
  selectable: boolean;
  onSelect: () => void;
  actions?: ReactNode;
  /** 纯文字说明(谁装的、在哪、咕咕管不管)—— 在单选项里面。 */
  detail?: ReactNode;
  /** 可交互的附加内容(输入格、进度、重试、链接)—— 在单选项外面,与文字左缘对齐。 */
  extra?: ReactNode;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!selectable) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <div data-testid={testId} data-in-use={inUse} className="flex flex-col py-2.5">
      <div className="flex items-start gap-3">
        <div
          role="radio"
          aria-checked={inUse}
          aria-disabled={!selectable && !inUse}
          tabIndex={selectable ? 0 : -1}
          onClick={selectable ? onSelect : undefined}
          onKeyDown={onKeyDown}
          className={cn(
            'flex min-w-0 flex-1 items-start gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring',
            selectable && 'cursor-pointer',
          )}
        >
          {/* 圆点:实心 = 在用。 */}
          <span
            aria-hidden="true"
            className={cn(
              'mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full border',
              inUse ? 'border-foreground' : 'border-foreground/25',
            )}
          >
            {inUse && <span className="size-2 rounded-full bg-foreground" />}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-baseline gap-2 text-sm">
              <span className="shrink-0 font-medium text-foreground">{title}</span>
              {value && <span className="min-w-0 truncate text-foreground">{value}</span>}
              {inUse && <span className="shrink-0 text-xs text-foreground-muted">{inUseLabel}</span>}
            </div>
            {detail}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {extra && <div className="pl-7">{extra}</div>}
    </div>
  );
}

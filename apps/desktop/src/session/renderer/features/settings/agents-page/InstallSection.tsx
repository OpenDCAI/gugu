import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  useAgentInstallationStatus,
  useInstallSourceVersions,
} from '@renderer/lib/stores/use-agent-installation-statuses';
import type {
  AgentPayload,
  Installation,
  InstallMethod,
  InstallOption,
  SelectedSource,
} from '@shared/core/agents/agent-payload';
import { sameSelection, withRegistryChoice } from '@shared/core/agents/agent-payload';
import { AgentSourceList, type SourceKind } from './AgentSourceList';
import { resolveHarnessState } from './harness-state';
import {
  describedInstallation,
  isManagedInstallOption,
  isManualRef,
  liveRefFor,
  registryRows,
  toSelection,
} from './installation-sources';
import { AgentAdvancedSection } from './AgentAdvancedSection';
import { InstallationOverrideCard } from './InstallationOverrideCard';
import { resolveManagedUpdate, resolveUpdateAction } from './update-action';

export type InstallSectionProps = {
  agentId: string;
  /** Full agent payload used to hydrate the hook before the first probe. */
  agentPayload: AgentPayload | undefined;
  /** Platform-specific install options from the agent payload. */
  installOptions: InstallOption[];
  /** Link to installation documentation, null if not set. */
  installDocs?: string | null;
  /**
   * 「账号」那一段。排在状态之后、高级之前 —— 装没装 → 登没登 → 高级,是用户要回答的顺序。
   * 这一段自己画上边那条细线,没有账号行的家(它返回 null)就连线一起没有。
   */
  accountSlot?: ReactNode;
};

/**
 * 面板里那张安装卡的接线(#6157)。
 *
 * ❌ 这里曾经是一台「选来源」的机器:来源下拉、副本列表、装法单选、下载源单选、`⋯` 菜单,
 * 加起来五个控件都在问用户同一类问题 ——「你要用哪一份 / 用什么方式 / 从哪儿下」。owner 拍板
 * 全部收掉:界面上一家只有一种状态、三个按钮,选源由主进程按测速自己决定。
 *
 * `selectedSource` 这份意向**留着**(账还需要它,持久化层与运行时都读它),但现在只有「高级」
 * 那两项改得动它:自定义可执行文件路径(path / cli)与手动指定下载源(registry)。
 */
export const InstallSection = observer(function InstallSection({
  agentId,
  agentPayload,
  installOptions,
  installDocs,
  accountSlot,
}: InstallSectionProps) {
  const vm = useAgentInstallationStatus(agentId, agentPayload);
  const hasRegistryOptions = installOptions.some((option) => option.registry !== undefined);
  /**
   * 各下载源的「最新版本」。这一趟请求**本来就要发**(高级那一项要把版本列出来),
   * 主进程顺手给它们计时 —— 装的时候按「谁先正确答出来」选源(#6157 的自动选源)。
   */
  const sourceVersionsQuery = useInstallSourceVersions(agentId, hasRegistryOptions);

  const [selectedSource, setSelectedSource] = useState<SelectedSource>(() =>
    liveRefFor(vm.used, vm.installations),
  );
  /**
   * 用户在「高级」里点开了「自定义可执行文件路径」。
   *
   * 这是一份**独立的意向**,不能由状态代答 —— 指定的是命令名(`reclaude` 这类 wrapper)时尤其
   * 要紧:代答会把它改写成一个空路径。#6087
   */
  const [manualOpen, setManualOpen] = useState(false);

  // 跟随主进程那份 `used`(后台探测、装完/更新完都会改它)。
  //
  // ❌ 别拿 `sourceKey` 当"变没变"的判据:它**故意**不含下载源。拿它比,「只换了下载源」永远
  //    读作没变,读回来的下载源就被原地丢掉 —— 重启后用户发现自己指定的镜像没了。#4271
  useEffect(() => {
    if (vm.isInstalling || vm.isUpdating || !vm.used) return;
    const liveRef = liveRefFor(vm.used, vm.installations);
    setSelectedSource((prev) => (sameSelection(prev, liveRef) ? prev : liveRef));
  }, [vm.used, vm.isInstalling, vm.isUpdating]);

  // Persisted override values used as initial inputs for the override card.
  const initialPath = useMemo(() => {
    const inst = vm.installations.find((i) => i.id === 'path');
    return inst?.pathEntry ?? '';
  }, [vm.installations]);

  const initialCli = useMemo(() => {
    const inst = vm.installations.find((i) => i.id === 'cli');
    return inst?.pathEntry ?? '';
  }, [vm.installations]);

  /** 手动输入框的预填值:选中态自己带的优先,退回到持久化下来的那条记录。 */
  const manualInitialValue =
    selectedSource.kind === 'path'
      ? selectedSource.path || initialPath
      : selectedSource.kind === 'cli'
        ? selectedSource.command || initialCli
        : '';

  const isOverrideEmpty =
    isManualRef(selectedSource) &&
    ((selectedSource.kind === 'path' && !initialPath) ||
      (selectedSource.kind === 'cli' && !initialCli));

  /**
   * 卡片描述哪一份 —— 判据在 `describedInstallation`。手动指定刚打开还没填值时它给的是
   * **运行时真会跑的那一份**,所以版本号不会在副本都在的时候消失。#6101
   */
  // 用运行时真会跑的那一份判「在用」:选中的是咕咕那份、而它已经被卸掉时,运行时落回自动嗅探,
  // 面板也得跟着指到「本机找到的」—— ❌ 不能三行都空着(真机:卸掉咕咕的 Pi 之后一个「在用」都没有)。
  const describedInstall = describedInstallation({
    installations: vm.installations,
    selectedSource: liveRefFor(selectedSource, vm.installations),
    overrideEmpty: isOverrideEmpty,
  });

  /** 这一家**根本**有没有托管安装 —— 只认不装的那些家在 descriptor 上就没有装法(#6098)。 */
  const managedInstall = useMemo(
    () =>
      installOptions.find(
        (o) =>
          isManagedInstallOption(o) &&
          (selectedSource.registry === undefined || o.registry === selectedSource.registry),
      ) ?? installOptions.find(isManagedInstallOption),
    [installOptions, selectedSource.registry],
  );

  const registries = useMemo(
    () => registryRows(installOptions, sourceVersionsQuery.data, sourceVersionsQuery.isPending),
    [installOptions, sourceVersionsQuery.data, sourceVersionsQuery.isPending],
  );

  /** 状态判据与图标网格**同一个函数** —— ❌ 两处各算一遍就是 #6101 那格 bug 的形状。 */
  const state = resolveHarnessState({
    reading: vm.data?.reading ?? agentPayload?.reading ?? 'not-detected',
    status: vm.status,
    busy: vm.isInstalling || vm.isUpdating,
    // 另几条腿的程序有新版本也算(#6335)—— 顶上那一行与「更新」按钮说同一件事。
    updateAvailable:
      !!describedInstall?.updateAvailable ||
      (vm.data?.programs ?? []).slice(1).some((program) => program.managedUpdateAvailable),
  });

  const onInstall = () => {
    if (!managedInstall) return;
    void vm.install(managedInstall.method, selectedSource.registry);
  };

  /**
   * 手动指定校验通过。
   *
   * 界面上只有一条输入框,填的内容决定它是路径还是命令 —— 所以**回来的 kind 才是真的**,
   * 选中态要跟着它走。不把选中态一起翻过来,存下去的就是一个空路径,重启后那次指定整个丢失。#4271
   */
  const onOverrideResolved = (installation: Installation | null) => {
    if (installation?.status !== 'available') return;
    const value = installation.pathEntry ?? '';
    const registry = selectedSource.registry ? { registry: selectedSource.registry } : {};
    const ref: SelectedSource =
      installation.id === 'cli'
        ? { kind: 'cli', command: value, ...registry }
        : { kind: 'path', path: value, ...registry };
    setSelectedSource(ref);
    void vm.setUsed(toSelection(ref, { path: value, cli: value }));
    setManualOpen(false);
  };

  /**
   * 点「自定义路径」那一行的「指定… / 修改」:只是把输入卡打开。
   *
   * ❌ 不在这一下改选中态:从前这里会先把选中态改成 `{kind:'path', path:''}`,于是还没填任何东西,
   * 「在用」那一行就先跳了一下;点「取消」之后选中态也回不去。真正的切换发生在校验通过那一刻
   * (`onOverrideResolved`)。预填值照旧来自已存的那一份(#6087)。
   */
  const openManual = () => setManualOpen(true);

  /**
   * 自定义可执行文件路径那张输入卡。
   *
   * 已经在用一个手动指定的目标时它常驻(不然用户没地方改它);点「高级」里那一项也能把它开出来。
   * ❌ 判据不能写成「选中的那一份好不好使」—— 手动指定过一个能跑的目标之后再点它,
   * 界面会一个像素都不变(owner 实遇,#6087)。
   */
  const manualSlot = manualOpen ? (
    // 输入框里的点击 ❌ 不冒泡成「切到这一行」。
    <div onClick={(e) => e.stopPropagation()}>
      <InstallationOverrideCard
        /* 换了一家 / 换了预填值就重新播种输入框 —— ❌ 不靠组件自己 `useState(initial)`:
           那一份只在挂载时读一次,留在屏幕上的会是上一次的文字。 */
        key={`${agentId}:${manualInitialValue}`}
        vm={vm}
        initialValue={manualInitialValue}
        onResolved={onOverrideResolved}
        onCancel={() => setManualOpen(false)}
      />
    </div>
  ) : undefined;

  /** 手动指定下载源。undefined = 自动 —— 存下来的 `used` 里就不带 registry。 */
  const onRegistryChange = (registry: string | undefined) => {
    const ref = withRegistryChoice(selectedSource, registry);
    setSelectedSource(ref);
    void vm.setUsed(toSelection(ref, { path: initialPath, cli: initialCli }));
  };

  /**
   * 三种来源各是哪一份(owner 2026-09-22:「本机默认嗅探的 / 咕咕安装管理 / 自定义路径」)。
   *
   * - 咕咕管理 = 咕咕亲手装的那份(`provenance.ours`,判据见 types.ts,不是推断)。
   * - 自定义路径 = 用户指定的那一条(id 是 'path' / 'cli')。
   * - 本机找到的 = 其余里 PATH 上排第一的那份;PATH 上第一个恰好是咕咕那份时,退到别的自装副本。
   */
  const isOverride = (i: Installation) => i.id === 'path' || i.id === 'cli';
  const managedCopy = vm.installations.find((i) => i.provenance.ours === true);
  const customCopy = vm.installations.find(isOverride);
  const localCopy =
    vm.installations.find((i) => i.isActive && !i.provenance.ours && !isOverride(i)) ??
    vm.installations.find((i) => !i.provenance.ours && !isOverride(i));

  /** 「在用」= 运行时真会跑的那一份(`describedInstallation`,面板显示哪份咕咕就启动哪份)。 */
  const inUse: SourceKind | null = !describedInstall
    ? null
    : isOverride(describedInstall)
      ? 'custom'
      : describedInstall.provenance.ours
        ? 'managed'
        : 'local';

  /** 点一行 = 切到那一份。下载源是另一件事,切换时原样带着(#4271)。 */
  const onSelect = (kind: SourceKind) => {
    const reg = selectedSource.registry ? { registry: selectedSource.registry } : {};
    let ref: SelectedSource | null = null;
    let values: { path?: string; cli?: string } = {};
    if (kind === 'local' && localCopy) {
      // 本机找到的就是「自动嗅探」;它不是 PATH 上第一个时才钉住那个具体文件。
      ref = localCopy.isActive
        ? { kind: 'auto', ...reg }
        : { kind: 'pinned', realpath: localCopy.realpath, ...reg };
    } else if (kind === 'managed' && managedCopy) {
      ref = { kind: 'method', method: managedCopy.provenance.kind as InstallMethod, ...reg };
    } else if (kind === 'custom' && customCopy?.pathEntry) {
      const value = customCopy.pathEntry;
      ref =
        customCopy.id === 'cli'
          ? { kind: 'cli', command: value, ...reg }
          : { kind: 'path', path: value, ...reg };
      values = { path: value, cli: value };
    }
    if (!ref) return;
    setSelectedSource(ref);
    void vm.setUsed(toSelection(ref, values));
  };

  /** 咕咕那份的更新:解析得出原地升级的命令就原地升级,否则重装一份最新的。 */
  const managedUpdateAction = resolveManagedUpdate({
    updateAction: resolveUpdateAction(agentPayload, managedCopy, selectedSource.registry, agentId),
    managedInstall,
    registry: selectedSource.registry,
  });
  /**
   * 另几条腿的程序(#6335)里,咕咕那一份有新版本的 —— 那是一次原地更新:主进程只动有新版本的那几个
   * (`updatePartsFor`)。❌ 不走「装一份最新的」那一支:那会把主程序(400 MB)也重下一遍。
   */
  const companionUpdate = (vm.data?.programs ?? []).slice(1).some((program) => program.managedUpdateAvailable);
  const onManagedUpdate =
    managedCopy?.updateAvailable && managedUpdateAction
      ? () => {
          if (managedUpdateAction.kind === 'update') {
            void vm.update(managedUpdateAction.method, managedUpdateAction.registry);
          } else {
            void vm.install(managedUpdateAction.method, managedUpdateAction.registry);
          }
        }
      : managedCopy && companionUpdate && managedInstall
        ? () => void vm.update(managedInstall.method, selectedSource.registry)
        : undefined;

  return (
    <>
      <AgentSourceList
        vm={vm}
        agentPayload={agentPayload}
        inUse={inUse}
        local={localCopy}
        managed={managedCopy}
        custom={customCopy}
        canInstall={!!managedInstall}
        canUninstall={canUninstall(agentPayload, managedCopy, state)}
        installDocs={installDocs}
        onSelect={onSelect}
        onInstall={onInstall}
        onUpdate={onManagedUpdate}
        onOpenCustom={openManual}
        customEditor={manualSlot}
      />
      {accountSlot}
      <AgentAdvancedSection
        agentId={agentId}
        registries={registries}
        registry={selectedSource.registry}
        onRegistryChange={onRegistryChange}
      />
    </>
  );
});

/**
 * 卸载只卸咕咕装的那一份(spec)。
 *
 * 选中的是用户自己的副本时这个按钮**不出现** —— 与其给一个按钮、让他点下去再被运行时拒掉,
 * 不如一开始就不摆。#4271 那次正是这道闸只写在注释里、没写进代码,于是咕咕跑 `brew uninstall`
 * 把用户亲手装的东西删了。
 */
function canUninstall(
  agentPayload: AgentPayload | undefined,
  installation: Installation | undefined,
  state: ReturnType<typeof resolveHarnessState>,
): boolean {
  const descriptor = agentPayload?.capabilities.hostDependency.uninstall;
  if (!descriptor || descriptor.kind === 'none') return false;
  if (state === 'installing') return false;
  // 几个程序的家(#6335):合并读数在终端腿那个程序没装时是「未安装」,可聊天面板那个是咕咕装的 ——
  // 卸载照样要给,不然用户得先装一个他不要的程序才卸得掉另一个。
  if (state === 'not-installed' && !agentPayload?.programs) return false;
  return installation?.provenance.ours === true;
}

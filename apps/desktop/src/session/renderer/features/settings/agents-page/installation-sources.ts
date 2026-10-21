import type {
  HostDependencySelection,
  Installation,
  InstallOption,
  InstallSourceVersions,
  SelectedSource,
} from '@shared/core/agents/agent-payload';
import { npmRegistryLabel } from '@gugu/session-core/deps';
import { resolveActiveInstallation } from '@shared/core/agents/agent-payload';

/**
 * 「用哪一份 / 从哪儿下载」那本账(#6157 之后)。
 *
 * ❌ 这个文件曾经还负责**画**那套选择器:副本列表、装法行、来源分组、卡片状态机。owner 拍板
 * 把那一整套从用户视野里删掉 —— 界面上一家只有一种状态、三个按钮(spec
 * `task-renderer/harness-install-panel`)。
 *
 * 剩下的**仍然是真事实**,只是不再是用户要回答的问题:选中哪一份要持久化(运行时按它挑可执行
 * 文件)、下载源要能被「高级」里那一项指定。所以这里留下的是账本那一半:选择的读写、
 * 「这一家咕咕装不装得了」、以及各下载源的版本行。
 */

/**
 * The copy a source selection resolves to, or undefined when that source has none here.
 *
 * A registry is a place to download the same package from, not a copy of its own — so a picked
 * mirror never demands its own installation, and `resolveActiveInstallation` answering with a
 * same-method copy from elsewhere is the correct answer, not a fallback to work around. #4271
 */
export function findInstallation(
  installs: Installation[],
  ref: SelectedSource,
): Installation | undefined {
  return resolveActiveInstallation(installs, ref);
}

export function toSelection(
  ref: SelectedSource,
  overrideValues: { path?: string; cli?: string } = {},
): HostDependencySelection {
  const reg = ref.registry ? { registry: ref.registry } : {};
  if (ref.kind === 'pinned') return { kind: 'pinned', realpath: ref.realpath, ...reg };
  if (ref.kind === 'path') return { kind: 'path', path: overrideValues.path ?? '', ...reg };
  if (ref.kind === 'cli') return { kind: 'cli', command: overrideValues.cli ?? '', ...reg };
  if (ref.kind === 'method') return { kind: 'method', method: ref.method, ...reg };
  // auto:只有带着下载源时才值得存,否则 null(= 什么都没选)
  return ref.registry ? { kind: 'auto', registry: ref.registry } : null;
}

/**
 * 咕咕自己能执行的装法 —— 今天只有托管安装一种(内置 mise,#6098)。
 *
 * **一条判据,两处用**:界面上「这一家有没有安装 / 更新按钮」与「下载源那一项要不要出现」问的是
 * 同一件事 —— 咕咕会不会替他去下载。
 * ❌ 两处各写一份判据:装法那一格曾经写 `method === 'npm' || method === 'mise'`,而菜单那一格
 * 写的是别的,于是同一家在一处摆着源、在另一处说「这个源与它无关」。
 */
export function isManagedInstallOption(option: { method: string }): boolean {
  return option.method === 'mise';
}

// ---------------------------------------------------------------------------
// RegistryRow — 「从哪儿下载」那一项(只在「高级」里出现)
// ---------------------------------------------------------------------------

/**
 * 下载源。它与「用哪一份」是两件事:改它不改变咕咕启动哪一个副本,只改变下次取包从哪儿取。
 *
 * 默认**不选** —— 主进程按测速自己挑(spec:「下载源不让用户选」)。这一组只在「高级 →
 * 手动指定下载源」里出现,给那些知道自己要什么的人一个覆盖口。
 */
export type RegistryRow = {
  registry: string;
  label: string;
  version?: string | null;
  outdated?: boolean;
  loading?: boolean;
  recommended?: boolean;
  /** 该源答了,但不带这台机器需要的平台包 —— 展示但不可选。 */
  unusable?: boolean;
};

export function registryRows(
  installOptions: InstallOption[],
  sourceVersions?: InstallSourceVersions,
  sourceVersionsLoading = false,
): RegistryRow[] {
  const seen = new Set<string>();
  const rows: RegistryRow[] = [];
  for (const o of installOptions) {
    // 下载源只对咕咕会去执行的那条装法有意义 —— 判据与「给不给安装按钮」同一条。
    if (!isManagedInstallOption(o) || !o.registry || seen.has(o.registry)) continue;
    seen.add(o.registry);
    // 只有 registry + registryPackage 都在时版本探测才真的会去查;只凭 registry 就渲染版本行,
    // 会留下一个永远「版本未知」的行,与真的探测失败分不开。
    const hasVersion = Boolean(o.registryPackage);
    const info = sourceVersions?.[o.registry];
    rows.push({
      registry: o.registry,
      // @@@raw registry label — 与安装选项标签同源,都是 NPM_REGISTRIES 里的原始名字。
      label: npmRegistryLabel(o.registry) ?? o.registry,
      recommended: o.recommended,
      ...(hasVersion
        ? {
            version: info?.version ?? null,
            outdated: info?.outdated ?? false,
            loading: sourceVersionsLoading && info === undefined,
          }
        : {}),
      ...(info?.platformBuildMissing ? { unusable: true } : {}),
    });
  }
  return rows;
}

/**
 * 用户在「自定义可执行文件路径」里填的到底是路径还是命令名。
 *
 * ❌ 判据不能是「以 `/` 开头」—— Windows 上绝对路径是 `C:\...` 或 `\\server\share\...`,
 * 那条判据在那儿全盘失效,每个 Windows 用户填的绝对路径都会被当成命令名交给 PATH。
 *
 * 两者在底层仍是两种 selection:路径会被校验、找不到就回落到自动;命令名原样交给 PATH 解析,
 * 不校验也不回落。界面上合成一个输入框是因为**用户从「路径 / 命令」这两个词里读不出这条差别**
 * (探测那头两个分支甚至逐字相同),而不是因为它们真的一样。#4271
 */
export function looksLikeAbsolutePath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value.trim());
}

export function refFromUsed(used: SelectedSource | undefined): SelectedSource {
  return used ?? { kind: 'auto' };
}

/**
 * 面板该把哪一份显示成「在用」。
 *
 * 存下来的选择可能指向一个**从没兑现的装法**(装到一半走了)。那时运行时会落回自动解析并照常把
 * agent 跑起来 —— 面板就必须显示自动解析到的那一份,否则它挂着一个空选择,而用户实际在用的是
 * 别的东西(spec:「面板显示哪一份,咕咕就启动哪一份」)。
 *
 * 只对 `method` 这样 —— pinned / path / cli 指的是**具体目标**,目标没了要如实说「不在了」,
 * ❌ 不能悄悄换成别的副本。#4271
 */
export function liveRefFor(
  used: SelectedSource | undefined,
  installations: Installation[],
): SelectedSource {
  const ref = refFromUsed(used);
  if (ref.kind !== 'method') return ref;
  if (findInstallation(installations, ref)) return ref;
  if (!installations.some((i) => i.status === 'available')) return ref;
  return ref.registry ? { kind: 'auto', registry: ref.registry } : { kind: 'auto' };
}

/**
 * 面板描述的是**哪一份**。
 *
 * 通常就是选中的那一份;手动指定刚打开、还没填值时是个例外 —— 那不是一次选择(持久化层读它
 * 就是「什么都没选」),运行时跑的是自动解析的那一份,面板也就该说那一份。#6101
 *
 * 口径只有这一处:状态与版本号都问它,❌ 别在组件里再算一遍 —— 两处各算一次的那一刻,
 * 顶上那行状态说的和版本号说的就会是两份东西。
 */
export function describedInstallation(input: {
  installations: Installation[];
  selectedSource: SelectedSource;
  /** 选的是手动指定,但还没有值。 */
  overrideEmpty: boolean;
}): Installation | undefined {
  if (isManualRef(input.selectedSource) && input.overrideEmpty) {
    return input.installations.find((installation) => installation.isActive);
  }
  return findInstallation(input.installations, input.selectedSource);
}

/** 选中的是不是手动指定的目标(path / cli 在界面上是同一条)。 */
export function isManualRef(
  ref: SelectedSource,
): ref is { kind: 'path'; path: string } | { kind: 'cli'; command: string } {
  return ref.kind === 'path' || ref.kind === 'cli';
}

import type {
  HostDependencyDescriptor,
  InstallOption,
} from '../../../host-dependencies/capability';
import {
  DEFAULT_NPM_REGISTRY_ID,
  mirrorRegistryIds,
  npmRegistryLabel,
  npmRegistryUrl,
  type NpmRegistryId,
} from '../../../host-dependencies/npm-registries';

/**
 * 产品内的安装只有两种形态(owner 2026-09-21,#6098):
 *
 *  1. **托管安装** —— 咕咕用内置的 mise 把厂商发布的平台归档装进自己的目录:`miseDependency`。
 *  2. **只认你自己装的那份** —— 自动检测到的副本 + 手动指定路径/命令名:`recognisedDependency`。
 *
 * ❌ 不再有 npm / Homebrew / curl 脚本 / powershell / winget / 自定义命令的产品内直装:
 * 一家一条装法各自落点,正是「安装事实靠推断、探测失败折成未安装、Windows 假设反复复发」
 * 的根(#6098 的论证)。装不了的家就明说装不了,让用户自己装完在上面选那一份 —— 一句
 * 「装不了」比一个按下去会失败的按钮诚实。
 */

/**
 * 这些 JS 写的 CLI 跑在哪个 node 上 —— **一份钉子,所有 npm backend 的家共用**。
 *
 * 为什么钉到补丁号:mise 的 npm backend 装完的东西是 `node_modules/.bin/<名字>` 这样一个
 * `#!/usr/bin/env node` 的壳,它**必须**有 node 才跑得起来(实测:PATH 里没有 node 时
 * 直接 `exec: node: not found`)。咕咕不赌用户机器上有 node,自己钉一个装进自己的目录,
 * 启动器把它前置到 PATH。
 *
 * ⚠️ 一份而不是一家一份:八家各写一遍必然漂,而「跑在哪个 node 上」不是厂商事实、是咕咕的选择。
 * 要升就升这一处;升完那几家会各自装一次新 node(旧的留着给还没升的版本用)。
 * 取值 = 2026-09-22 用打包的那份 mise(`mise ls-remote node`)读到的最新 24.x LTS。
 */
/**
 * `HostDependencyDescriptor.versionLine` 给「`--version` 只打一行裸版本号」的家:那一行就是版本号(行尾空白、Windows 的
 * `\r` 都容)。包装器的 banner 行不会是裸版本号,所以认得出。2026-10-28 Linux 2 实测(npm 装真包跑 `--version`)
 * 是这个样子的:cline、codebuddy、commandcode、continue、gemini、kilocode、kimi、mimocode、opencode、pi、qoder、qwen。
 */
export const BARE_VERSION_LINE = /^v?\d+\.\d+\.\d+\s*$/;

export const MANAGED_NODE_VERSION = '24.21.0';

/** 厂商把程序体作为 npm 平台包发布:归档里有一个可直接执行的文件。 */
type MisePlatformArchive = {
  /** 发布这个 CLI 的 npm 包:平台包从它的 `optionalDependencies` 里取,版本也读它。 */
  package: string;
  /** `<process.platform>-<process.arch>` → 平台归档内可执行文件的相对路径(strip_components=1 之后)。
   *  ❌ 只声明厂商真的发了平台包的那几格:少一格 = 那个平台上说「装不了」,编一格 = 装完校验失败。 */
  executables: Record<string, string>;
  /**
   * `<process.platform>-<process.arch>` → 承载该平台构建的 npm 包名。
   * 省略即 `<package>-<platform>-<arch>`(claude / codex / amp / copilot 就是这个形状)。
   * 厂商换了名字才写这一格,每条都是关于厂商命名的事实:bun 编出来的那几家把 `win32` 叫
   * `windows`,cline 的平台包在 `@cline/cli-*` 下,mimocode 的在 `@mimo-ai/mimocode-*` 下。
   */
  platformPackages?: Record<string, string>;
  backend?: undefined;
};

/** 纯 JS 的 npm 包:mise 的 npm backend 用内置 aube 装,不需要机器上有 node/npm。 */
type MiseNpmBackend = {
  backend: 'npm';
  /** 这个 CLI 的 npm 包名 —— 装的就是它,版本也读它。 */
  package: string;
  /** 跑它要的 node 版本钉。写 `MANAGED_NODE_VERSION`,❌ 不要在这里写第二个字面量。 */
  node: string;
};

/**
 * 登记在官方 ACP 注册表里的 ACP 服务(#6335):版本与各平台归档 URL 都读注册表那一条
 * (FORMAT.md 的 `distribution.binary`),交给 mise 的 http backend。
 *
 * · 没有下载源菜单:注册表那一条只给一个 URL,npm 镜像与它无关(镜像是 npm 的分发点)。
 * · 不执行它探版本:这类 ACP 服务没有我们确知的 `--version`(antigravity 的 `agy_acp_server`
 *   是 802 MB 的 Python par,跑一次就是起一个服务)。装的是哪个版本,由咕咕写进启动器的
 *   发行标记回答(`mise-installer.ts` 的 `managedLauncher`),❌ 不猜。
 */
type MiseAcpRegistry = {
  backend: 'acp-registry';
  /** 注册表里的 agent id(`antigravity-acp`)。 */
  agentId: string;
};

/**
 * 厂商自己发的按平台版本清单(#6335,Google 给 `agy` 的 auto-updater):
 * `<manifest 模板,{platform} 换成厂商平台键>` → `{ version, url, sha512 }`。
 *
 * · 没有下载源菜单:清单只给一个 URL,npm 镜像与它无关。
 * · 执行它探版本(`--version`)—— 这类是普通 CLI,装完那一步要核「跑出来的就是清单那个版本」。
 * · 载荷可以是归档(取 `archiveExecutable`)也可以是裸可执行文件(Windows 的 `agy` 是一个 `.exe`)。
 */
type MiseVendorManifest = {
  backend: 'vendor-manifest';
  /** 清单 URL 模板,含且只含一个 `{platform}`。 */
  manifest: string;
  /** `<process.platform>-<process.arch>[-musl]` → 厂商平台键。只写厂商真发了的那几格。 */
  platforms: Record<string, string>;
  /** 归档载荷里可执行文件的相对路径(`agy` 的 tar.gz 里是单独一个 `antigravity`)。 */
  archiveExecutable: string;
};

/**
 * 托管安装 —— 咕咕用打包进来的 mise 把这一家装进咕咕自己的目录,再发布一个启动器。
 *
 * 三种分发形态,按**厂商实际怎么发**选(#6098、#6335):
 *
 * · 平台归档(`executables`):厂商把程序体作为 npm 平台包发布,mise 的 http backend 拿那个
 *   tarball + 它的 sha512。归档里必须有一个**可直接执行**的文件。
 * · npm backend(`backend: 'npm'`):纯 JS 的包 —— 依赖树要装,mise 的内置 aube 就是干这个的,
 *   不需要机器上有 node 或 npm。装出来的 CLI 自己要 node,所以同时钉一个
 *   `MANAGED_NODE_VERSION` 一起装(mise 保证先装 node 再装包)。
 * · ACP 注册表(`backend: 'acp-registry'`):厂商把 ACP 服务登记在官方 ACP 注册表,
 *   归档 URL 与版本读注册表那一条(见 `MiseAcpRegistry`)。
 *
 * ❌ 别看见「它在 npm 上」就随手挑一种:归档里是不是可执行文件、依赖树要不要装,是核过厂商
 * 分发形状才知道的事(grok 的平台包里是 Brotli 压缩的 `.br`,zero 的平台包不是它本体)。
 */
export function miseDependency(
  opts: {
    /** mise 的分发 slug 兼二进制名 —— 启动器文件名与 `binaryNames` 都用它。
     *  写**厂商真正的二进制名**(kilocode 的是 `kilo`),否则用户自己装的那一份探不到。 */
    id: string;
    /**
     * 除了 `id` 之外还要探测的名字 —— **用户自己装的那一份可能叫什么**。
     *
     * 咕咕发布出去的启动器永远只叫 `id` 一个名字;这一格是给探测用的:厂商的 npm `bin`
     * 同时发好几个名字时(qoder 的 `qodercli`/`qoder`、command-code 的三个别名),
     * 只探 `id` 会把用户用别名装的那一份判成「没装」——一个不存在的缺失。
     * 顺序即探测顺序,`id` 恒在最前(`resolveFirstPath` 第一个命中就返回)。
     */
    aliases?: string[];
    /**
     * 提供哪些镜像下载源。省略 = 全部。
     *
     * 只写那种「没有探针能看见」的厂商分发事实,且每条都要注明日期的理由。
     * ❌ 不是用来记「这个镜像现在缺这个平台的构建」—— 那是源菜单打开时逐个现查的
     * (LatestVersionService.probePlatformBuild):镜像是懒同步的,答案按它们的节奏变,
     * 写死在这里的名单发出去就已经过时了。
     */
    mirrors?: NpmRegistryId[];
    /** 探版本用的参数,默认 `['--version']`。 */
    versionArgs?: string[];
    /** 解析出路径后不执行它(版本命令有副作用的家)。 */
    skipVersionProbe?: boolean;
    /** 厂商的安装文档,界面上作为链接。 */
    installDocs?: string;
  } & (MisePlatformArchive | MiseNpmBackend | MiseAcpRegistry | MiseVendorManifest),
): HostDependencyDescriptor {
  if (opts.backend === 'acp-registry') return acpRegistryDependency(opts);
  if (opts.backend === 'vendor-manifest') return vendorManifestDependency(opts);
  const offeredMirrors = opts.mirrors ?? mirrorRegistryIds();
  const registryChoicesEnabled = offeredMirrors.length > 0;
  // 命令文本里的工具名与执行层用的是同一个(`mise-installer.ts` 的 `miseToolName`)——
  // 界面上显示的那条命令必须就是真去跑的那条。
  const tool = opts.backend === 'npm' ? `npm:${opts.package}` : `http:gugu-${opts.id}`;
  const backend =
    opts.backend === 'npm'
      ? ({ kind: 'npm', node: opts.node } as const)
      : ({
          kind: 'platform-archive',
          executables: opts.executables,
          ...(opts.platformPackages ? { platformPackages: opts.platformPackages } : {}),
        } as const);

  const optionFor = (registryId: string): InstallOption => {
    // Fail loud rather than shipping a descriptor whose source menu names a registry we cannot
    // resolve; LatestVersionService throws on the same condition, so reads and writes agree.
    const url = npmRegistryUrl(registryId);
    if (!url) throw new Error(`Unknown npm registry: ${registryId}`);
    const label = npmRegistryLabel(registryId);
    if (!label) throw new Error(`npm registry has no label: ${registryId}`);
    return {
      method: 'mise',
      command: `mise install ${tool}`,
      updateCommand: `mise install ${tool}`,
      uninstallCommand: `mise uninstall ${tool}`,
      target: { kind: 'mise', package: opts.package, binary: opts.id, backend },
      // 历史上咕咕用 npm 装过同一家,那份副本归这条执行器接管(卸载时认得出来)。
      replaces: ['npm'],
      ...(registryChoicesEnabled ? { registry: registryId, registryPackage: opts.package } : {}),
      ...(registryId === DEFAULT_NPM_REGISTRY_ID ? { recommended: true } : {}),
    };
  };

  const options = [
    optionFor(DEFAULT_NPM_REGISTRY_ID),
    ...(registryChoicesEnabled ? offeredMirrors.map(optionFor) : []),
  ];

  return {
    binaryNames: [...new Set([opts.id, ...(opts.aliases ?? [])])],
    ...(opts.versionArgs ? { versionArgs: opts.versionArgs } : {}),
    ...(opts.skipVersionProbe ? { skipVersionProbe: true } : {}),
    ...(opts.installDocs ? { installDocs: opts.installDocs } : {}),
    installCommands: { macos: options, windows: options, linux: options },
    updates: {
      kind: 'supported',
      releaseSource: { kind: 'npm', package: opts.package },
      update: { kind: 'package-manager' },
    },
    uninstall: { kind: 'package-manager' },
  };
}

/** `miseDependency` 的 ACP 注册表那一支:一个选项、无镜像、不跑它探版本。 */
function acpRegistryDependency(opts: {
  id: string;
  aliases?: string[];
  installDocs?: string;
} & MiseAcpRegistry): HostDependencyDescriptor {
  // 与 `mise-installer.ts` 的 `miseToolName` 同一个名字 —— 界面上的命令就是真去跑的那条。
  const tool = `http:gugu-${opts.id}`;
  const option: InstallOption = {
    method: 'mise',
    command: `mise install ${tool}`,
    updateCommand: `mise install ${tool}`,
    uninstallCommand: `mise uninstall ${tool}`,
    // `package` 填注册表 agent id:它不是 npm 包,只是 target 上一个人读得懂的名字(capability.ts)。
    target: {
      kind: 'mise',
      package: opts.agentId,
      binary: opts.id,
      backend: { kind: 'acp-registry', agentId: opts.agentId },
    },
    recommended: true,
    // ❌ 不带 `registry` / `registryPackage`:那两格一出现,源菜单就会去 npm 上查一个不存在的包。
  };
  return {
    binaryNames: [...new Set([opts.id, ...(opts.aliases ?? [])])],
    skipVersionProbe: true,
    ...(opts.installDocs ? { installDocs: opts.installDocs } : {}),
    installCommands: { macos: [option], windows: [option], linux: [option] },
    updates: {
      kind: 'supported',
      releaseSource: { kind: 'acp-registry', agentId: opts.agentId },
      update: { kind: 'package-manager' },
    },
    uninstall: { kind: 'package-manager' },
  };
}

/** `miseDependency` 的厂商清单那一支:一个选项、无镜像、装完跑 `--version` 核版本。 */
function vendorManifestDependency(opts: {
  id: string;
  aliases?: string[];
  versionArgs?: string[];
  installDocs?: string;
} & MiseVendorManifest): HostDependencyDescriptor {
  // 与 `mise-installer.ts` 的 `miseToolName` 同一个名字 —— 界面上的命令就是真去跑的那条。
  const tool = `http:gugu-${opts.id}`;
  const option: InstallOption = {
    method: 'mise',
    command: `mise install ${tool}`,
    updateCommand: `mise install ${tool}`,
    uninstallCommand: `mise uninstall ${tool}`,
    // `package` 只是 target 上一个人读得懂的名字(它不是 npm 包),写成二进制名。
    target: {
      kind: 'mise',
      package: opts.id,
      binary: opts.id,
      backend: {
        kind: 'vendor-manifest',
        manifest: opts.manifest,
        platforms: opts.platforms,
        archiveExecutable: opts.archiveExecutable,
      },
    },
    recommended: true,
    // ❌ 不带 `registry` / `registryPackage`:那两格一出现,源菜单就会去 npm 上查一个不存在的包。
  };
  return {
    binaryNames: [...new Set([opts.id, ...(opts.aliases ?? [])])],
    ...(opts.versionArgs ? { versionArgs: opts.versionArgs } : {}),
    ...(opts.installDocs ? { installDocs: opts.installDocs } : {}),
    installCommands: { macos: [option], windows: [option], linux: [option] },
    updates: {
      kind: 'supported',
      releaseSource: { kind: 'vendor-manifest', manifest: opts.manifest, platforms: opts.platforms },
      update: { kind: 'package-manager' },
    },
    uninstall: { kind: 'package-manager' },
  };
}

/**
 * 只认不装:咕咕装不了这一家,但会认出用户自己装的那一份(自动检测 + 手动指定路径/命令名)。
 *
 * `installCommands` 留空**就是**那句话 —— 界面据此写「这家咕咕装不了,请自己装好后在上面选」,
 * ❌ 不再给一个按下去必然失败的安装按钮。`updates` 一并为 `none`:不是咕咕装的,咕咕也更不了
 * (更新动作本来就只对 `manageable` 的副本开放),声称能更新却拿不到落点就是说谎。
 *
 * 每一家为什么在这里,理由写在它自己的 descriptor 上方 —— 那是关于厂商分发形状的事实,
 * 会变;❌ 不在这儿存一份必然过时的名单。
 */
export function recognisedDependency(opts: {
  /** 探测顺序,第一个探到的赢。写厂商真正的二进制名。 */
  binaryNames: string[];
  /** 厂商的安装文档 —— 用户要自己装,这条链接就是他下一步要点的东西。 */
  installDocs?: string;
  /** 探版本用的参数,默认 `['--version']`。 */
  versionArgs?: string[];
  /** 解析出路径后不执行它(版本命令有副作用的家)。 */
  skipVersionProbe?: boolean;
  /** 厂商固定安装位置(CLI 不上 PATH 的家),见 `HostDependencyDescriptor.knownPaths`。 */
  knownPaths?: HostDependencyDescriptor['knownPaths'];
}): HostDependencyDescriptor {
  return {
    binaryNames: opts.binaryNames,
    ...(opts.knownPaths ? { knownPaths: opts.knownPaths } : {}),
    ...(opts.versionArgs ? { versionArgs: opts.versionArgs } : {}),
    ...(opts.skipVersionProbe ? { skipVersionProbe: true } : {}),
    ...(opts.installDocs ? { installDocs: opts.installDocs } : {}),
    installCommands: {},
    updates: { kind: 'none' },
  };
}

import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';

export {
  DEFAULT_NPM_REGISTRY_ID,
  mirrorRegistryIds,
  NPM_REGISTRIES,
  npmRegistryLabel,
  npmRegistryUrl,
} from './npm-registries';
export type { NpmRegistryId } from './npm-registries';

export const PLATFORMS = ['macos', 'windows', 'linux'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * 装法的唯一一份枚举 —— 两种角色合用一份:**咕咕会去执行的**装法,和**认出别人装的那份**
 * 时贴的来源标签。
 *
 * 今天只有 `mise` 是产品内真能执行的装法(agent 全家),加 git 这个核心依赖的
 * homebrew / apt / winget(`core-dependencies.ts`)。`npm` 与 `curl` 留着是因为它们仍是
 * **来源标签**:用户自己用 npm 装的那一份、厂商脚本装到 `~/.local/bin` 的那一份,面板上要
 * 说得出它是怎么来的(`runtime/location-hints.ts` 的 `inferMethod`),而 `mise` 那条执行器
 * 还要靠 `replaces: ['npm']` 接管咕咕历史上用 npm 装的副本。
 *
 * ❌ 别为「将来可能有人用」预留值。躺在这里 0 声明 0 推断的都删过了:
 * `installer-macos/-windows/-linux`、`pip`、`cargo`(#6096),以及 `powershell` 与 `other`
 * (#6098 —— 前者唯一的痕迹是一条指向 PowerShell 模块目录的路径猜测,而没有一家 CLI 装在
 * 那儿;后者连猜测都没有)。要加一种装法,等真有一家声明它的时候一起加。
 */
export const INSTALL_METHODS = [
  'homebrew',
  'winget',
  'npm',
  'mise',
  'apt',
  'curl',
] as const;
export type InstallMethod = (typeof INSTALL_METHODS)[number];

/**
 * 安装到哪一步了。顺序即先后 —— 界面据此说人话，而进度**不许倒退**。
 * 这份清单是唯一一份：zod 的 enum 与宿主那边的量测/解析都从这里取。
 */
export const INSTALL_PHASES = [
  'starting',
  'resolving',
  'downloading',
  'installing',
  'verifying',
] as const;
export type InstallPhase = (typeof INSTALL_PHASES)[number];

/** 一次安装的实时读数（不含 providerId —— 那是外层的事）。 */
export type InstallProgressReport = {
  phase: InstallPhase;
  bytesDone?: number;
  bytesTotal?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  elapsedMs: number;
};

/**
 * ACP 注册表的 agent id 形状:小写字母数字加连字符(注册表的目录名,`antigravity-acp`)。
 * 同时满足 mise target 上 `package` 那条正则 —— acp-registry 形态把 agent id 填进 `package`。
 */
export const ACP_REGISTRY_AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;

/** 官方 ACP 注册表的发布索引 —— 一个文件列出全部 agent(FORMAT.md,#6335)。 */
export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

/**
 * 厂商自己的「按平台一份」版本清单(#6335:Google 给 `agy` 的 auto-updater 就是这个形状)。
 *
 * URL 模板里必须有且只有一个 `{platform}` 占位,换成厂商的平台键后取回
 * `{ version, url, sha512 }`(sha512 为 128 位十六进制)。https 才收:清单决定下载哪份字节。
 */
export const VENDOR_MANIFEST_PLACEHOLDER = '{platform}';
const vendorManifestUrlSchema = z
  .string()
  .regex(/^https:\/\/[^\s]*\{platform\}[^\s]*$/)
  .refine((value) => value.split(VENDOR_MANIFEST_PLACEHOLDER).length === 2, 'exactly one {platform}');
/**
 * `<process.platform>-<process.arch>` 或 `linux-<arch>-musl` → 厂商的平台键(`darwin_arm64`)。
 * 表里没有的组合 = 厂商没发这一格,直接说装不了。musl 那一格按 glibc 是否在场判(与 install.sh 的
 * `ldd … | grep musl` 同一个问题,Node 侧答案是 `process.report` 的 `glibcVersionRuntime`)。
 */
const vendorManifestPlatformsSchema = z.record(
  z.string().regex(/^(?:darwin|linux|win32)-[a-z0-9]+(?:-musl)?$/),
  z.string().regex(/^[A-Za-z0-9_.-]+$/),
);

/**
 * 一个 harness 的**哪条腿**要跑这个程序(与渲染层 `SessionpageLeg` 同一对值,插件契约)。
 * 伴随程序(`companions`)按腿认领;没被认领的腿跑主程序。
 */
export const HOST_DEPENDENCY_LEGS = ['tui', 'acp'] as const;
export type HostDependencyLeg = (typeof HOST_DEPENDENCY_LEGS)[number];

export const installOptionSchema = z.object({
  method: z.enum(INSTALL_METHODS),
  command: z.string(),
  /** Optional package-manager target used to locate the bytes installed by this command. */
  target: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('npm-package'),
        package: z.string().regex(/^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/),
      }),
      z.object({
        kind: z.literal('mise'),
        package: z.string().regex(/^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/),
        binary: z.string().regex(/^[A-Za-z0-9_-]+$/),
        /**
         * 内置 mise 用哪种后端取这一家 —— 两种,按**厂商的分发形态**选,不是偏好:
         *
         * · `platform-archive`:厂商把程序体作为 npm 平台包发布(归档里就是一个可执行文件),
         *   mise 的 http backend 拿那个 tarball + 它的 sha512。
         * · `npm`:纯 JS 的 npm 包 —— mise 的 npm backend 用内置的 aube 装,不需要机器上有
         *   node/npm;装出来的 CLI 自己要 node,所以托管配置里同时钉一个 `node`(#6098)。
         * · `acp-registry`:厂商把 ACP 服务登记在官方 ACP 注册表
         *   (github.com/agentclientprotocol/registry,FORMAT.md 的 `distribution.binary`),
         *   各平台归档 URL 与版本都读注册表那一条,再交给 mise 的 http backend(#6335)。
         *   这一形态下 `package` 写注册表里的 agent id(与 `agentId` 相同)—— 它不是 npm 包,
         *   只是让「这一家装的是什么」在 target 上有一个人读得懂的名字。
         */
        backend: z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('platform-archive'),
            /** `<platform>-<arch>` → 平台归档内可执行文件的相对路径。 */
            executables: z.record(z.string(), z.string()),
            /**
             * `<platform>-<arch>` → 承载该平台构建的 npm 包名。缺省即 `<package>-<platform>-<arch>`。
             * 厂商的命名事实,不是配置开关(#6098)。
             */
            platformPackages: z
              .record(z.string(), z.string().regex(/^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/))
              .optional(),
          }),
          z.object({
            kind: z.literal('npm'),
            /**
             * 这些 CLI 跑起来要的 node 版本钉 —— 咕咕自己的选择,**钉到补丁号**。
             * mise 先把它装进咕咕自己的目录,再装 npm 包;启动器把它的 bin 目录前置到 PATH。
             */
            node: z.string().regex(/^\d+\.\d+\.\d+$/),
          }),
          z.object({
            kind: z.literal('acp-registry'),
            /** 注册表里的 agent id(`antigravity-acp`)—— 平台、归档、cmd 都从这一条里取。 */
            agentId: z.string().regex(ACP_REGISTRY_AGENT_ID),
          }),
          /**
           * · `vendor-manifest`:厂商自己发一份按平台的版本清单(`{version,url,sha512}`),
           *   URL 与 sha512 读清单,交给 mise 的 http backend(#6335 的 `agy`)。
           *   载荷两种形状都收:归档(取 `archiveExecutable` 那个文件)与**裸可执行文件**
           *   (Windows 的 `agy` 就是一个 `.exe`;mise 原样落盘并改名为 `binary`,实测见 mise-distribution)。
           */
          z.object({
            kind: z.literal('vendor-manifest'),
            manifest: vendorManifestUrlSchema,
            platforms: vendorManifestPlatformsSchema,
            /** 归档载荷里可执行文件的相对路径(POSIX)。裸文件载荷不读它。 */
            archiveExecutable: z.string().regex(/^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/),
          }),
        ]),
      }),
    ])
    .optional(),
  /** Human-readable display name shown in the UI. Defaults to a humanized method label. */
  label: z.string().optional(),
  /** App-owned legacy methods that this executor can migrate on update. */
  replaces: z.array(z.enum(INSTALL_METHODS)).optional(),
  /** When true this option is preselected and sorted first. */
  recommended: z.boolean().optional(),
  /** Update command for installs made via this method. When absent, falls back to re-running
   *  `command` for package-manager updates or the dependency's own CLI update command. */
  updateCommand: z.string().optional(),
  /** Uninstall command for installs made via this method. Required when the descriptor's
   *  `uninstall.kind` is `'package-manager'`. */
  uninstallCommand: z.string().optional(),
  /**
   * Registry id this option installs from (see NPM_REGISTRIES). Set for registry-distributed options that
   * were expanded per source; absent means "the method's default source".
   *
   * ❌ 它**不**进 `sourceKey`:镜像是同一个包的不同分发点,不构成另一份副本,所以「用哪一份」
   * 的分组键里没有它。要比较两次选择是否相同(含下载源)用 `sameSelection`。#4271
   */
  registry: z.string().optional(),
  /** npm package queried for per-registry version display. Present with registry. */
  registryPackage: z.string().optional(),
});
export type InstallOption = z.output<typeof installOptionSchema>;
export type InstallTarget = NonNullable<InstallOption['target']>;

/** Where to look up the latest published version. */
export const releaseSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('npm'), package: z.string() }),
  /** 官方 ACP 注册表里这一条的 `version`(registry.json 一次取回,所有家共用那一份)。#6335 */
  z.object({ kind: z.literal('acp-registry'), agentId: z.string().regex(ACP_REGISTRY_AGENT_ID) }),
  /** 厂商的按平台版本清单里的 `version`(取本机那一格 —— 装的也是那一格)。#6335 */
  z.object({
    kind: z.literal('vendor-manifest'),
    manifest: vendorManifestUrlSchema,
    platforms: vendorManifestPlatformsSchema,
  }),
  z.object({ kind: z.literal('github'), repo: z.templateLiteral([z.string(), '/', z.string()]) }),
  z.object({ kind: z.literal('none') }),
]);
export type ReleaseSource = z.output<typeof releaseSourceSchema>;

export const updateStrategySchema = z.discriminatedUnion('kind', [
  /** Re-run the install command for the method that was used, or the first/recommended option. */
  z.object({ kind: z.literal('package-manager') }),
  z.object({ kind: z.literal('none') }),
]);
export type UpdateStrategy = z.output<typeof updateStrategySchema>;

export const updatesDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('supported'),
    releaseSource: releaseSourceSchema,
    update: updateStrategySchema,
  }),
  z.object({ kind: z.literal('none') }),
]);
export type UpdatesDescriptor = z.output<typeof updatesDescriptorSchema>;

export const uninstallStrategySchema = z.discriminatedUnion('kind', [
  /** Run the per-method `uninstallCommand` declared on the matching InstallOption. */
  z.object({ kind: z.literal('package-manager') }),
  /** Uninstall not supported via the app; hide the option in the UI. */
  z.object({ kind: z.literal('none') }),
]);
export type UninstallStrategy = z.output<typeof uninstallStrategySchema>;

const hostDependencyBaseSchema = z.object({
  /**
   * Binary names to try in order; first success wins.
   *
   * 必填。❌ 这里曾经还有一个 `id`,36 家都写、**0 处读**（宿主一律用 `metadata.id`,见
   * `descriptor-from-provider.ts`),唯一副作用是给 `binaryNames` 兜一个默认值 —— 而那个
   * 兜底已经骗过一次:mimocode 为了借它把 `hostDependency.id` 写成 `'mimo'`，读起来像
   * 「这个插件叫 mimo」。二进制名是厂商的事实,写出来。
   */
  binaryNames: z.array(z.string()).min(1),
  /** Args passed when probing for a version string. Defaults to ['--version']. */
  versionArgs: z.array(z.string()).optional(),
  /** Skip executing the CLI after resolving its path.
   *  Use for CLIs whose version command has project-local side effects. */
  skipVersionProbe: z.boolean().optional(),
  /**
   * 厂商的**固定安装位置**,PATH 上的 `binaryNames` 都找不到时按平台依次找(`resolveKnownPaths`)。
   * 给「CLI 随桌面 app 发、不上 PATH」的家用。只写厂商安装包实际落盘的位置,并在声明处写出处;
   * 可用 `~/`(POSIX)与 `%VAR%`(Windows)。手动指定路径照旧优先于它。
   */
  knownPaths: z.partialRecord(z.enum(PLATFORMS), z.array(z.string().min(1))).optional(),
  installCommands: z.partialRecord(z.enum(PLATFORMS), z.array(installOptionSchema)),
  /** Optional link to installation documentation, shown in the dependency detail view. */
  installDocs: z.string().optional(),
  updates: updatesDescriptorSchema,
  /** Uninstall strategy. When absent, uninstall is not supported. */
  uninstall: uninstallStrategySchema.optional(),
});

/**
 * 伴随程序 —— 一个 harness 的某几条腿跑的是**另一个程序**(#6335:Antigravity 的聊天面板腿是
 * `agy_acp_server`,终端腿是 `agy`,Google 把两者做成两个独立发行的程序)。
 *
 * 每个伴随程序是一份**完整的**宿主依赖:有自己的依赖 id、自己的探测/安装/更新/卸载、自己的
 * 「用哪一份」选择 —— 依赖管理器里它就是一行普通的 agent 依赖,只是多一个属主(`ownerId`)。
 * 用户面上它不单列:属主那一家「装」= 两个都装,读数按腿合并(`agent-payload-builder`)。
 *
 * ❌ 不许嵌套(伴随程序自己不再带伴随程序);❌ 两个伴随程序不许认领同一条腿。
 */
export const hostDependencyCompanionSchema = z.object({
  /** 依赖 id —— 全局唯一,❌ 不许与任何插件 id 撞(`antigravity-cli`)。 */
  id: z.string().regex(ACP_REGISTRY_AGENT_ID),
  /** 给人看的名字(安装失败、进度里「第几个程序」时说得出是哪一个)。 */
  name: z.string().min(1),
  /** 这个程序服务哪几条腿。没被任何伴随程序认领的腿跑主程序。 */
  legs: z.array(z.enum(HOST_DEPENDENCY_LEGS)).min(1),
  dependency: hostDependencyBaseSchema,
});
export type HostDependencyCompanion = z.output<typeof hostDependencyCompanionSchema>;

export const hostDependencyDescriptorSchema = hostDependencyBaseSchema.extend({
  companions: z
    .array(hostDependencyCompanionSchema)
    .refine(
      (companions) => {
        const legs = companions.flatMap((companion) => companion.legs);
        return new Set(legs).size === legs.length;
      },
      'two companions claim the same leg',
    )
    .optional(),
});
export type HostDependencyDescriptor = z.output<typeof hostDependencyDescriptorSchema>;

export const hostDependencyCapability = definePluginCapability()(
  'host-dependency',
  hostDependencyDescriptorSchema,
);

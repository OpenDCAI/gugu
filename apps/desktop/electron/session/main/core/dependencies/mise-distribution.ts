import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ACP_REGISTRY_URL,
  DEFAULT_NPM_REGISTRY_ID,
  npmRegistryUrl,
  VENDOR_MANIFEST_PLACEHOLDER,
  type InstallTarget,
} from '@gugu/session-core/deps';

export type MiseTarget = Extract<InstallTarget, { kind: 'mise' }>;

/**
 * 平台归档:mise 的 http backend 拿一个钉死 URL 的归档。
 * npm 平台包那条恒带 sha512;ACP 注册表那条只在注册表给了 sha256 时带(`acp-registry`)。
 */
export type MiseArchiveDistribution = {
  kind: 'platform-archive' | 'acp-registry' | 'vendor-manifest';
  tool: string;
  version: string;
  installVersion: string;
  executable: string;
  /** 启动器在 `"$@"` 前固定带上的参数 —— 只有 ACP 注册表那一格会给(FORMAT.md 的 `args`)。 */
  args?: string[];
  config: string;
};

/**
 * npm backend:mise 用内置 aube 装这个包,另钉一个 node 给它跑。
 *
 * `installVersion` 就是 npm 上那个版本号,❌ 不掺下载源指纹 —— 镜像是同一个包的不同分发点,
 * 同一个版本在哪个镜像上都是同一份内容(平台归档那边要掺,因为 URL 本身不同)。
 */
export type MiseNpmDistribution = {
  kind: 'npm';
  tool: string;
  version: string;
  installVersion: string;
  /** 一起装的 node 版本钉;启动器要把它的 bin 目录前置到 PATH。 */
  node: string;
  config: string;
  /** 交给 mise 的额外环境 —— 下载源走 `NPM_CONFIG_REGISTRY`(mise 与 aube 都认它)。 */
  env: NodeJS.ProcessEnv;
};

export type MiseDistribution = MiseArchiveDistribution | MiseNpmDistribution;

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

type Manifest = {
  version: string;
  optionalDependencies?: Record<string, string>;
  dist?: { tarball: string; integrity: string };
};

function registryBase(registryId: string): string {
  const registry = npmRegistryUrl(registryId);
  if (!registry) throw new Error('Unknown registry: ' + registryId);
  return registry;
}

async function fetchManifest(
  registry: string,
  name: string,
  version: string,
  signal?: AbortSignal,
): Promise<Manifest> {
  const response = await fetch(registry + '/' + encodeURIComponent(name) + '/' + encodeURIComponent(version), {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Package metadata HTTP ' + response.status + ': ' + name + '@' + version);
  return await response.json() as Manifest;
}

/**
 * `<process.platform>-<process.arch>` → ACP 注册表的平台键(FORMAT.md「Platform Targets」)。
 * 注册表用 `darwin/linux/windows` × `aarch64/x86_64`,node 用 `darwin/linux/win32` × `arm64/x64`。
 * 表里没有的组合 = 注册表不认识的平台,直接说装不了。
 */
const ACP_REGISTRY_PLATFORMS: Record<string, string> = {
  'darwin-arm64': 'darwin-aarch64',
  'darwin-x64': 'darwin-x86_64',
  'linux-arm64': 'linux-aarch64',
  'linux-x64': 'linux-x86_64',
  'win32-arm64': 'windows-aarch64',
  'win32-x64': 'windows-x86_64',
};

/** FORMAT.md 列出的归档格式。原始二进制(不带归档)与安装器格式(.dmg/.msi…)这里不接。 */
const ACP_ARCHIVE = /\.(?:zip|tar\.gz|tgz|tar\.bz2|tbz2)$/i;

type AcpRegistryBinary = { archive?: unknown; cmd?: unknown; args?: unknown; sha256?: unknown };
type AcpRegistryAgent = { id?: unknown; version?: unknown; distribution?: { binary?: Record<string, AcpRegistryBinary> } };

/** 取回官方 ACP 注册表的发布索引 —— 超时与 npm 元数据那条同一口径。 */
export async function fetchAcpRegistry(signal?: AbortSignal): Promise<{ agents: AcpRegistryAgent[] }> {
  const response = await fetch(ACP_REGISTRY_URL, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('ACP registry HTTP ' + response.status);
  const json = await response.json() as { agents?: unknown };
  if (!Array.isArray(json.agents)) throw new Error('ACP registry has no agent list');
  return { agents: json.agents as AcpRegistryAgent[] };
}

/**
 * 注册表的 `cmd` → 归档解压根下的相对路径(POSIX 分隔)。
 *
 * FORMAT.md:cmd 相对**解压根**。注册表里真实出现过的写法有 `./x`、裸 `x.exe`、
 * 以及 Windows 反斜杠 `./dist-package\cursor-agent.cmd`(2026-09-23 读 registry.json)——
 * 统一折成 `/`,去掉开头的 `./`。❌ 含 `..` 或是绝对路径的一律拒绝:那会让启动器指到安装目录之外。
 */
export function acpRegistryExecutable(cmd: string): string {
  const normalized = cmd.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  if (!normalized || normalized.split('/').includes('..') || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('Invalid ACP registry command path: ' + cmd);
  }
  return normalized;
}

async function resolveAcpRegistryDistribution(
  target: MiseTarget & { backend: { kind: 'acp-registry' } },
  signal: AbortSignal | undefined,
  platform: NodeJS.Platform,
  arch: string,
): Promise<MiseArchiveDistribution> {
  const key = ACP_REGISTRY_PLATFORMS[platform + '-' + arch];
  if (!key) throw new Error('Unsupported mise target: ' + platform + '-' + arch);
  const { agents } = await fetchAcpRegistry(signal);
  const agent = agents.find((entry) => entry?.id === target.backend.agentId);
  if (!agent) throw new Error('ACP registry has no agent: ' + target.backend.agentId);
  // FORMAT.md:根上的 `version` 恒为纯 `X.Y.Z`(预发布只在 preview 通道,且 binary 不支持 preview)。
  if (typeof agent.version !== 'string' || !VERSION.test(agent.version)) throw new Error('Invalid published version');
  const binary = agent.distribution?.binary?.[key];
  // 厂商没发这一格 —— antigravity-acp 1.1.1 就没有 darwin-x86_64。说「装不了」,❌ 不拿别的平台顶。
  if (!binary) throw new Error('Unsupported mise target: ' + platform + '-' + arch + ' (' + key + ' is not published)');
  if (typeof binary.archive !== 'string' || !/^https:\/\//i.test(binary.archive)) throw new Error('ACP registry archive must be an https URL');
  const archiveName = new URL(binary.archive).pathname;
  if (!ACP_ARCHIVE.test(archiveName)) throw new Error('Unsupported ACP registry archive format: ' + archiveName);
  if (typeof binary.cmd !== 'string') throw new Error('ACP registry entry has no command');
  const executable = acpRegistryExecutable(binary.cmd);
  // `args` 是这一格启动命令的一部分(FORMAT.md),❌ 丢掉:antigravity-acp 1.2.1 给 Linux 写了 `--uid=`,
  // 不带它进程要切到 `nobody` 组,Ubuntu 上没有这个组(那里叫 nogroup)⇒ `Check failed … Group nobody not found` 后 abort。
  const args = binary.args ?? [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error('ACP registry args must be a string array');
  // sha256 在 FORMAT.md 里是可选的(antigravity-acp 1.1.1 就没给);给了就必须是 64 位十六进制并交给 mise 校验。
  let checksum: string | undefined;
  if (binary.sha256 !== undefined) {
    if (typeof binary.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(binary.sha256)) throw new Error('Invalid ACP registry SHA-256');
    checksum = binary.sha256.toLowerCase();
  }
  const tool = 'http:gugu-' + target.binary;
  // 同一个版本号换了 URL(或换了校验和)就是另一份字节:指纹掺进版本目录,❌ 不把缓存里的旧那份改个名当新下载。
  // 参数换了也是另一种启动法:掺进指纹,装一次就重写启动器;没有参数时指纹与从前逐字相同。
  const fingerprint = createHash('sha256')
    .update(binary.archive + '\n' + (checksum ?? '') + (args.length > 0 ? '\n' + JSON.stringify(args) : ''))
    .digest('hex').slice(0, 32);
  const installVersion = agent.version + '-acp-' + fingerprint;
  const config = [
    '[tools.' + JSON.stringify(tool) + ']',
    'version = ' + JSON.stringify(installVersion),
    'url = ' + JSON.stringify(binary.archive),
    ...(checksum ? ['checksum = ' + JSON.stringify('sha256:' + checksum)] : []),
    // cmd 相对解压根(FORMAT.md),所以原样解压、❌ 不剥层:antigravity 的 zip 根上直接就是
    // `agy_acp_server.par` 与 `localharness_external` 两个文件(实测),剥一层就把它们剥没了。
    // 写明 0 而不是省略:两者都省略时 mise 会在「根上只有一个目录」时自动剥一层(docs/dev-tools/backends/http.md)。
    'strip_components = 0',
    'bin_path = ' + JSON.stringify(path.posix.dirname(executable)),
    '',
  ].join('\n');
  return { kind: 'acp-registry', tool, version: agent.version, installVersion, executable, ...(args.length > 0 ? { args } : {}), config };
}

/**
 * 这台机器在厂商清单里是哪一格的**查表键**:`<platform>-<arch>`,Linux 上用 musl 的再加 `-musl`。
 *
 * musl 的判据与厂商 install.sh 问的是同一件事(「这台 Linux 的 libc 是不是 musl」):
 * Node 的诊断报告在 glibc 上带 `glibcVersionRuntime`,musl 上没有这一格。
 */
export function vendorPlatformLookupKey(
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean = platform === 'linux' && !linuxHasGlibc(),
): string {
  return platform + '-' + arch + (platform === 'linux' && musl ? '-musl' : '');
}

function linuxHasGlibc(): boolean {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return typeof header?.glibcVersionRuntime === 'string';
}

type VendorManifestBackend = Extract<MiseTarget['backend'], { kind: 'vendor-manifest' }>;

/** 本机那一格的清单 URL;厂商没发这一格就是 null(调用方说「装不了」)。 */
export function vendorManifestUrl(
  backend: Pick<VendorManifestBackend, 'manifest' | 'platforms'>,
  lookupKey: string,
): string | null {
  const vendorKey = backend.platforms[lookupKey];
  return vendorKey ? backend.manifest.replace(VENDOR_MANIFEST_PLACEHOLDER, encodeURIComponent(vendorKey)) : null;
}

/** 厂商清单那一条的形状:三格全是必填,任何一格不对就响亮失败,❌ 不猜。 */
export type VendorManifestRelease = { version: string; url: string; sha512: string };

export function parseVendorManifest(json: unknown): VendorManifestRelease {
  const entry = json as { version?: unknown; url?: unknown; sha512?: unknown } | null;
  if (typeof entry?.version !== 'string' || !VERSION.test(entry.version)) throw new Error('Invalid published version');
  if (typeof entry.url !== 'string' || !/^https:\/\//i.test(entry.url)) throw new Error('Vendor manifest url must be an https URL');
  if (typeof entry.sha512 !== 'string' || !/^[0-9a-fA-F]{128}$/.test(entry.sha512)) throw new Error('Vendor manifest has no valid SHA-512');
  return { version: entry.version, url: entry.url, sha512: entry.sha512.toLowerCase() };
}

export async function fetchVendorManifest(url: string, signal?: AbortSignal): Promise<VendorManifestRelease> {
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Vendor manifest HTTP ' + response.status + ': ' + url);
  return parseVendorManifest(await response.json());
}

/** 载荷是不是归档 —— 按 URL 路径的后缀判(mise 的 http backend 也是这么判的)。其余一律当裸可执行文件。 */
const VENDOR_ARCHIVE = /\.(?:zip|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2|tar\.zst|tzst)$/i;

/**
 * 厂商自己的按平台版本清单(#6335 的 `agy`)。
 *
 * 两种载荷:
 *  · 归档(darwin/linux 的 tar.gz,包里就一个 `antigravity`):原样解压、❌ 不剥层,
 *    可执行文件 = `archiveExecutable`。
 *  · 裸可执行文件(windows 的 `cli_windows_x64.exe`):mise 的 http backend 对非归档 URL 原样落盘,
 *    `bin` 给它定名 —— 实测(2026-09-24,打包的 mise 2026.9.12,本地 http 服务一个 `.exe` 后缀的
 *    裸文件 + `bin = "agy"`):落在 `<install>/agy`、带可执行位。Windows 上定名为 `<binary>.exe`,
 *    否则 CreateProcess 认不出它是程序。
 *
 * ⚠️ 启动器与落盘文件都叫 `binary`(`agy`),❌ 永远不叫 `antigravity`:咕咕的 bin 目录前置在 PATH 上,
 * 而「在 Antigravity IDE 中打开」靠 PATH 上的 `antigravity` 判 IDE(openInApps.ts)。
 * 归档里那个 `antigravity` 留在 mise 的版本目录里,不在 PATH 上。
 */
async function resolveVendorManifestDistribution(
  target: MiseTarget & { backend: VendorManifestBackend },
  signal: AbortSignal | undefined,
  platform: NodeJS.Platform,
  arch: string,
  musl?: boolean,
): Promise<MiseArchiveDistribution> {
  const lookupKey = vendorPlatformLookupKey(platform, arch, musl);
  const url = vendorManifestUrl(target.backend, lookupKey);
  if (!url) throw new Error('Unsupported mise target: ' + lookupKey);
  const release = await fetchVendorManifest(url, signal);
  const tool = 'http:gugu-' + target.binary;
  // 同一个版本号换了 URL / 校验和就是另一份字节:指纹掺进版本目录(与 ACP 注册表那条同一个理由)。
  const fingerprint = createHash('sha256').update(release.url + '\n' + release.sha512).digest('hex').slice(0, 32);
  const installVersion = release.version + '-vm-' + fingerprint;
  const archive = VENDOR_ARCHIVE.test(new URL(release.url).pathname);
  let executable: string;
  let layout: string[];
  if (archive) {
    executable = acpRegistryExecutable(target.backend.archiveExecutable);
    layout = [
      // 写明 0:两者都省略时 mise 会在「根上只有一个目录」时自动剥一层(docs/dev-tools/backends/http.md)。
      'strip_components = 0',
      'bin_path = ' + JSON.stringify(path.posix.dirname(executable)),
    ];
  } else {
    executable = target.binary + (platform === 'win32' ? '.exe' : '');
    layout = ['bin = ' + JSON.stringify(executable)];
  }
  const config = [
    '[tools.' + JSON.stringify(tool) + ']',
    'version = ' + JSON.stringify(installVersion),
    'url = ' + JSON.stringify(release.url),
    'checksum = ' + JSON.stringify('sha512:' + release.sha512),
    ...layout,
    '',
  ].join('\n');
  return { kind: 'vendor-manifest', tool, version: release.version, installVersion, executable, config };
}

/** Resolve the chosen distribution source; mise owns all artifact download and extraction. */
export async function resolveMiseDistribution(
  target: MiseTarget,
  registryId = DEFAULT_NPM_REGISTRY_ID as string,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  /** 只给测试用;缺省按本机 libc 判(`vendorPlatformLookupKey`)。 */
  musl?: boolean,
): Promise<MiseDistribution> {
  // ACP 注册表只有一个 URL:npm 下载源在这条上没有意义,❌ 不去查它(也就不会因为一个镜像 id 报错)。
  if (target.backend.kind === 'acp-registry') {
    return resolveAcpRegistryDistribution({ ...target, backend: target.backend }, signal, platform, arch);
  }
  // 厂商清单同理:只有一个 URL,与 npm 下载源无关。
  if (target.backend.kind === 'vendor-manifest') {
    return resolveVendorManifestDistribution({ ...target, backend: target.backend }, signal, platform, arch, musl);
  }
  const registry = registryBase(registryId);
  if (target.backend.kind === 'npm') {
    // 版本自己解析出来再钉给 mise:`@latest` 交给 mise 也行,但那样装完对不上账 ——
    // 「装的是哪个版本」要在装之前就是一个已知的值,inventory 与 `--version` 才有东西可核。
    const main = await fetchManifest(registry, target.package, 'latest', signal);
    if (!VERSION.test(main.version)) throw new Error('Invalid published version');
    const tool = 'npm:' + target.package;
    return {
      kind: 'npm',
      tool,
      version: main.version,
      installVersion: main.version,
      node: target.backend.node,
      // node 与这个包都写进托管配置:mise 的 npm backend 把 `node` 当**安装依赖**,
      // 配置里没有它就没有「先装 node」这件事(实测:声明了但没装,mise 直接拒绝安装)。
      config: [
        '[tools]',
        'node = ' + JSON.stringify(target.backend.node),
        JSON.stringify(tool) + ' = ' + JSON.stringify(main.version),
        '',
      ].join('\n'),
      // mise 的版本查询与 aube 的安装都认 `NPM_CONFIG_*`(docs/dev-tools/backends/npm.md),
      // 所以「显示版本、更新检查、实际取包」三处同源这条承诺在这条后端上照旧成立。
      env: { NPM_CONFIG_REGISTRY: registry },
    };
  }
  const executable = target.backend.executables[platform + '-' + arch];
  if (!executable || executable.split(/[\\/]/).includes('..') || path.posix.isAbsolute(executable)) {
    throw new Error('Unsupported mise target: ' + platform + '-' + arch);
  }
  const main = await fetchManifest(registry, target.package, 'latest', signal);
  if (!VERSION.test(main.version)) throw new Error('Invalid published version');
  // 平台包名默认按 `<package>-<platform>-<arch>`;厂商换了命名的那几家在 descriptor 里写明。
  const name = target.backend.platformPackages?.[platform + '-' + arch] ?? target.package + '-' + platform + '-' + arch;
  const spec = main.optionalDependencies?.[name];
  if (!spec) throw new Error('Platform package missing: ' + name + '@' + main.version);
  const alias = spec.startsWith('npm:') ? spec.slice(4) : name + '@' + spec;
  const at = alias.lastIndexOf('@');
  const payload = await fetchManifest(registry, alias.slice(0, at), alias.slice(at + 1), signal);
  const integrity = payload.dist?.integrity;
  if (!payload.dist?.tarball || !integrity?.startsWith('sha512-')) throw new Error('Platform package has no SHA-512 integrity');
  const checksum = Buffer.from(integrity.slice(7), 'base64');
  if (checksum.length !== 64) throw new Error('Invalid platform package SHA-512 integrity');
  const url = /^https?:\/\//i.test(payload.dist.tarball)
    ? payload.dist.tarball
    : registry.replace(/\/$/, '') + '/' + payload.dist.tarball.replace(/^\/+/, '');
  const tool = 'http:gugu-' + target.binary;
  // A cached version from another source must not be relabelled as a new download.
  const installVersion = main.version + '-' + registryId + '-' + checksum.toString('hex').slice(0, 32);
  const config = [
    '[tools.' + JSON.stringify(tool) + ']',
    'version = ' + JSON.stringify(installVersion),
    'url = ' + JSON.stringify(url),
    'checksum = ' + JSON.stringify('sha512:' + checksum.toString('hex')),
    'strip_components = 1',
    'bin_path = ' + JSON.stringify(path.posix.dirname(executable)),
    '',
  ].join('\n');
  return { kind: 'platform-archive', tool, version: main.version, installVersion, executable, config };
}

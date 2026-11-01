import { execInProcessGroup } from '@gugu/session-core/exec';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { log } from '@main/lib/logger';
import lockfile from 'proper-lockfile';
import { INSTALL_PHASES, type InstallProgressReport } from '@gugu/session-core/deps';
import { DOWNLOAD_STAGE } from '@gugu/session-core/deps/runtime';
import type { InstallCommandContext, InstallCommandError } from '@gugu/session-core/deps/runtime';
import { err, ok, type Result } from '@gugu/session-shared';
import release from '@shared/core/agents/mise-release.json';
import { managedAgentBinDir, managedAgentNpmRoot, managedAgentPrefix, managedMiseBinDir } from './managed-agent-home';
import { resolveMiseDistribution, type MiseTarget } from './mise-distribution';
import { miseProgress, runMiseProcess } from './mise-process';
import { startInstallProgressMeter } from './install-progress-meter';
import { buildAgentEnv } from '@main/core/pty/pty-env';
import { anySignal } from '@gugu/core/shared/anySignal';

const IDLE_MS = 60_000;
/** 装到一半时多久往日志里记一笔进度:卡住时日志里要看得出停在哪一步(#7199 那次 2.5 分钟一行都没有)。 */
const PROGRESS_LOG_EVERY_MS = 30_000;

export function miseEnvironment(root: string, config: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Only OS/transport inputs cross the installer boundary. Account keys and user mise settings do not.
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase())));
  return {
    ...env,
    MISE_DATA_DIR: path.join(root, 'data'), MISE_CACHE_DIR: path.join(root, 'cache'),
    MISE_CONFIG_DIR: path.join(root, 'config'), MISE_STATE_DIR: path.join(root, 'state'),
    MISE_SYSTEM_CONFIG_DIR: path.join(root, 'system'), MISE_GLOBAL_CONFIG_FILE: config,
    MISE_GLOBAL_CONFIG_ROOT: root, MISE_CEILING_PATHS: root, MISE_TRUSTED_CONFIG_PATHS: root,
    MISE_OVERRIDE_CONFIG_FILENAMES: 'gugu.mise.toml',
    MISE_YES: '1', MISE_COLOR: '0', MISE_EXPERIMENTAL: '1', MISE_JOBS: '1',
  };
}

export function bundledMisePath(): string {
  const osName = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'mise-bundle')
    : path.join(app.getAppPath(), 'mise-bundle', osName + '-' + process.arch);
  return path.join(root, 'mise', 'bin', process.platform === 'win32' ? 'mise.exe' : 'mise');
}

function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/**
 * 这一家在 mise 里叫什么 —— 界面上显示的那条命令与真去跑的那条必须是同一个名字。
 * 平台归档与 ACP 注册表两种形态都走 http backend,工具名同形(`http:gugu-<binary>`)。
 */
export function miseToolName(target: MiseTarget): string {
  return target.backend.kind === 'npm' ? 'npm:' + target.package : 'http:gugu-' + target.binary;
}

/**
 * 启动器里那一行发行标记:咕咕装的是哪个版本,**写下来**而不是跑出来。
 *
 * 给 ACP 注册表那一形态用(#6335):那些 ACP 服务没有我们确知的 `--version`,执行它就是起一个
 * 服务,所以 descriptor 带 `skipVersionProbe`,版本读这一行(`readManagedLauncherRelease`)。
 * 值 = 装之前就从注册表钉死的版本号,与 mise 版本目录同源。
 */
const RELEASE_MARKER = 'gugu-release: ';

/** 从咕咕写的启动器里读出发行标记;不是咕咕的启动器、或没有这一行,就是 null —— ❌ 不猜。 */
export function launcherRelease(script: string): string | null {
  const line = script.split(/\r?\n/).find((entry) => /^(?:#|rem) gugu-release: /i.test(entry));
  const version = line?.slice(line.indexOf(RELEASE_MARKER) + RELEASE_MARKER.length).trim();
  return version && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

/**
 * 读一份托管启动器的发行标记 —— 只认咕咕自己那个 bin 目录里的文件。
 * 给依赖管理器的 `readManagedVersion` 用:`skipVersionProbe` 的家靠它报「装的是哪个版本」。
 */
export async function readManagedLauncherRelease(file: string): Promise<string | null> {
  const resolved = path.resolve(file);
  if (path.dirname(resolved).toLowerCase() !== path.resolve(managedMiseBinDir()).toLowerCase()) return null;
  try { return launcherRelease(await readFile(resolved, 'utf8')); } catch { return null; }
}

/**
 * mise 把工具名折成目录名的规则:去掉 `@`,`:`、`/` 与 `_` 变 `-`。
 * 实测(2026-09-22,打包的 2026.9.12):`npm:@google/gemini-cli` → `npm-google-gemini-cli`,
 * `http:gugu-claude` → `http-gugu-claude`;(2026-09-23 同一份 mise)`http:gugu-agy_acp_server`
 * → `http-gugu-agy-acp-server` —— 下划线也折。量测进度要照着它找目录,❌ 别猜。
 */
export function miseToolSlug(tool: string): string {
  return tool.replaceAll('@', '').replaceAll(':', '-').replaceAll('/', '-').replaceAll('_', '-');
}

/**
 * 发布出去的启动器。`pathPrefix` 给 npm backend 用:装出来的 `node_modules/.bin/<名字>` 是一个
 * `#!/usr/bin/env node` 的壳,PATH 里没有 node 就直接 `exec: node: not found`(实测),
 * 所以启动器要把咕咕自己那份 node 的 bin 目录前置进去。
 */
export function managedLauncher(executable: string, pathPrefix?: string, release?: string, args: readonly string[] = []): string {
  if (process.platform === 'win32') {
    const relative = path.relative(managedMiseBinDir(), executable);
    // `%~dp0` 相对:整个托管目录被搬走之后这条壳仍然指得对。
    const prefix = pathPrefix
      ? 'set "PATH=%~dp0' + path.relative(managedMiseBinDir(), pathPrefix) + ';%PATH%"\r\n'
      : '';
    const marker = release ? 'rem ' + RELEASE_MARKER + release + '\r\n' : '';
    const fixed = args.map((arg) => ' "' + arg + '"').join('');
    return '@echo off\r\n' + marker + prefix + '"%~dp0' + relative + '"' + fixed + ' %*\r\n';
  }
  // A real script (not a symlink) keeps installation identity stable across mise's version directories.
  // 可执行文件按绝对路径 exec:同目录的兄弟文件(antigravity 的 `localharness_external`)原地不动,
  // 程序按自己的位置找到它们 —— 启动器只指路,❌ 不搬文件。
  const marker = release ? '# ' + RELEASE_MARKER + release + '\n' : '';
  const prefix = pathPrefix ? 'PATH=' + shellQuote(pathPrefix) + ':"$PATH"\nexport PATH\n' : '';
  const fixed = args.map((arg) => ' ' + shellQuote(arg)).join('');
  return '#!/bin/sh\n' + marker + prefix + 'exec ' + shellQuote(executable) + fixed + ' "$@"\n';
}

/**
 * npm backend 装出来的可执行文件在哪 —— **读出来的**,不是拼出来的。
 * aube 落在 `node_modules/.bin/`,外部包管理器落在 `bin/`(mise 的 `bin_paths_for_install_path`
 * 两个都找)。Windows 上那个壳带什么后缀由包管理器定,所以逐个试、都不在就响亮报错。
 */
async function resolveNpmExecutable(directory: string, binary: string): Promise<string> {
  const dirs = [path.join(directory, 'node_modules', '.bin'), path.join(directory, 'bin')];
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, binary + suffix);
      try { await access(candidate); return candidate; } catch { /* 下一个候选 */ }
    }
  }
  throw new Error('Installed package has no "' + binary + '" executable under ' + dirs.join(' or '));
}

/** Mise owns downloads, verification, version directories and removal; Gugu owns publication and selection. */
export async function runMiseOperation(context: InstallCommandContext, preparation?: { root: string; launcherDir: string }): Promise<Result<void, InstallCommandError>> {
  const request = context.mise;
  if (!request) throw new Error('Mise operation target is required');
  const { target, operation } = request;
  const tool = miseToolName(target);
  const root = preparation?.root ?? path.join(managedAgentPrefix(), 'mise');
  const work = path.join(root, 'operations', target.binary);
  const config = path.join(work, 'global.toml');
  const launcher = path.join(preparation?.launcherDir ?? managedMiseBinDir(), target.binary + (process.platform === 'win32' ? '.cmd' : ''));
  // 与 agent 同一份环境(buildAgentEnv):用户登录 shell 里的代理、只开系统代理时补的代理(#6892)都在这里;
  // miseEnvironment 再按自己的白名单只留 OS / 传输层那几格。
  let env = miseEnvironment(root, config, buildAgentEnv());
  const mise = bundledMisePath();
  const started = Date.now();
  const abort = new AbortController();
  const signal = anySignal([context.signal, abort.signal]);
  let releaseLock: (() => Promise<void>) | undefined;
  let meter: ReturnType<typeof startInstallProgressMeter> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle = false;
  let candidate: string | undefined;
  let candidateExisted = false;
  let published = false;
  let previousConfig: string | undefined;
  /**
   * 正在**取包**那一段(#6157)。
   *
   * 从「向源问发行物」起,到 mise 那条 install 命令跑完为止 —— 源不通、超时、
   * sha512 校验不过都落在这一段里。失败带上这个标记,上层才分得出「换个源重试一次有意义」
   * 与「装完之后的失败,换源也一样」(判据 `isDownloadStageFailure`)。
   * ❌ 不靠在 `output` 里认字符串:那串字来自 mise / aube / node 三层,换个版本就漂。
   */
  let downloading = false;
  /**
   * 最后一次进度读数(#7199):失败、取消、卡住时带回去,说清**卡在哪一步** ——
   * 取清单(resolving)/ 下载(已下多少、共多少、多快)/ 解压安装(installing)/ 校验(verifying)。
   */
  let lastReport: InstallProgressReport | undefined;
  let measuredBytes = 0;
  let lastLoggedAt = 0;
  const progress = (report: InstallProgressReport) => {
    const phaseChanged = report.phase !== lastReport?.phase;
    lastReport = report;
    if (phaseChanged || Date.now() - lastLoggedAt >= PROGRESS_LOG_EVERY_MS) {
      lastLoggedAt = Date.now();
      log.info('[mise-installer] 安装进度', { tool, ...report });
    }
    context.onProgress?.(report);
  };
  /**
   * 失败那一刻的进度。mise 自己报了分子分母就照用它的(同一个文件的一手计数);
   * 没报总量时才用落点目录实测的字节数 —— 那个数把下载文件、解出来的副本、node 都算在里面,
   * 和 mise 的分母不是一个口径,❌ 拼在一起(会出现「469.0/119.5 MB」)。
   */
  const lastProgress = (): InstallProgressReport | undefined => {
    if (!lastReport && measuredBytes === 0) return undefined;
    const base: InstallProgressReport = lastReport ?? { phase: 'downloading', elapsedMs: 0 };
    const bytesDone = base.bytesTotal !== undefined ? base.bytesDone ?? 0 : Math.max(base.bytesDone ?? 0, measuredBytes);
    return { ...base, ...(bytesDone > 0 ? { bytesDone } : {}), elapsedMs: Date.now() - started };
  };
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => { idle = true; abort.abort(); }, IDLE_MS); };
  const run = (args: string[], cancellable = true, onOutput?: (line: string) => void) => {
    const deadline = args[0] === 'install' ? undefined : AbortSignal.timeout(cancellable && args[0] === 'uninstall' ? 60_000 : 15_000);
    const signals = [...(cancellable ? [signal] : []), ...(deadline ? [deadline] : [])];
    return runMiseProcess(mise, args, { cwd: work, env, ...(signals.length ? { signal: anySignal(signals) } : {}), onOutput });
  };
  const inventory = async (toolName: string = tool): Promise<Array<{ version: string; install_path: string; installed: boolean }>> => {
    const output = await run(['ls', '--json', toolName]);
    const entries: unknown = JSON.parse(output);
    // Filtered 'mise ls --json TOOL' is an array; the unfiltered command returns an object.
    if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.version !== 'string' || typeof entry.install_path !== 'string' || typeof entry.installed !== 'boolean')) throw new Error('Invalid mise installation inventory');
    return entries;
  };
  /**
   * #6264 升级一家 agent 之后收掉更早的版本:mise 每个版本一个目录,以前从不回收 —— codex 一版 370MB,
   * 每升级一次盘上就多一份(d22 的系统盘就是这样满的)。只留新装的这一版与启动器原来指着的那一版
   * (它可能正被一条还开着的会话用着,npm 系的 agent 运行中还会按需读自己目录里的文件)。
   * 收不掉只记一笔:新版本已经在用了,❌ 为清理失败把这次安装判成失败。
   */
  const pruneStaleVersions = async (previousLauncher: string): Promise<void> => {
    try {
      const stale = (await inventory()).filter(
        (entry) => entry.installed && entry.version !== candidate && !previousLauncher.includes(path.resolve(entry.install_path)),
      );
      for (const entry of stale) await run(['uninstall', tool + '@' + entry.version], false);
    } catch (error) {
      log.warn('[mise-installer] 收旧版本失败(不影响这次安装)', { tool, error: String(error) });
    }
  };
  const perform = async (): Promise<Result<void, InstallCommandError>> => {
    try {
      signal.throwIfAborted();
      try { await access(mise); } catch { throw new Error('Bundled installation engine is missing. Reinstall Gugu.'); }
      await mkdir(work, { recursive: true });
      releaseLock = await lockfile.lock(work, { realpath: false, stale: 30_000, update: 10_000, retries: 0, onCompromised: (error) => abort.abort(error) });
      try { await access(config); } catch { await writeFile(config, ''); }
      const version = await run(['--version']);
      if (!version.startsWith(release.version + ' ')) throw new Error('Unexpected bundled mise version: ' + version);
      const old = await inventory();
      if (operation === 'uninstall') {
        const selected = request.selectedPath;
        const legacyBin = managedAgentBinDir();
        const isLegacy = selected && path.dirname(selected).toLowerCase() !== path.dirname(launcher).toLowerCase();
        if (!isLegacy) {
          await run(['uninstall', '--all', tool]);
          if ((await inventory()).some((entry) => entry.installed)) throw new Error('Mise still reports an installed version after removal');
          await rm(launcher, { force: true });
          await writeFile(config, '');
        } else {
          // Legacy Gugu npm copies predate mise's inventory. Retire only their private package and launchers.
          const packageRoot = path.join(managedAgentNpmRoot(), target.package);
          if (!selected.startsWith(managedAgentPrefix() + path.sep)) throw new Error('Selected legacy installation is outside the managed directory');
          await rm(packageRoot, { recursive: true, force: true });
          for (const suffix of ['', '.cmd', '.ps1']) await rm(path.join(legacyBin, target.binary + suffix), { force: true });
        }
        return ok();
      }
      progress({ phase: 'resolving', elapsedMs: 0 });
      downloading = true;
      const distribution = await resolveMiseDistribution(target, request.registry, signal);
      candidate = distribution.installVersion;
      candidateExisted = old.some((entry) => entry.version === candidate && entry.installed);
      previousConfig = await readFile(config, 'utf8');
      await writeFile(config, distribution.config);
      // 下载源交给 mise 与 aube:`NPM_CONFIG_REGISTRY`(docs/dev-tools/backends/npm.md)。
      if (distribution.kind === 'npm') env = { ...env, ...distribution.env };
      touch();
      const slug = miseToolSlug(tool);
      const measured = [path.join(root, 'data', 'downloads', slug), path.join(root, 'data', 'installs', slug)];
      // node 也是这一次安装的一部分(第一次装 npm backend 的家时要下 50MB),量它才不会
      // 出现「进度条一动不动、其实正在下 node」。
      // 包本身边下边解进 aube 的 store(`MISE_CACHE_DIR/npm/aube/store`),installs 目录要到最后才长;
      // 下包那一段 mise 的进度行也只数「装完几个包」(实测 61MB 的 CodeBuddy:`97/106 pkgs · 5.9 MiB`
      // 一动不动地挂到装完)—— 不量这里,下得慢一点的包整段都没有进展可看。
      if (distribution.kind === 'npm') {
        measured.push(path.join(root, 'data', 'downloads', 'node'), path.join(root, 'data', 'installs', 'node'), path.join(root, 'cache', 'npm'));
      }
      // store 是各家共用的:量表只数这次开工之后写进来的文件(ctime),读数单调,真卡死时一个字节都不涨。
      meter = startInstallProgressMeter({
        dirs: measured,
        onSample: (sample) => { if (sample.bytesDone > measuredBytes) { measuredBytes = sample.bytesDone; touch(); } },
      });
      let lastPhase: string | undefined;
      let lastBytes = 0;
      // 进度**不许倒退**(capability.ts 的 INSTALL_PHASES 顺序即先后)。npm 后端一次装两样东西:
      // node 先下完装好,包才开始 `checking package` —— 原样转发就会让界面从「安装中」跳回
      // 「解析中」。这里只挡回退,❌ 不加工数字。
      const phaseRank = (phase: string) => INSTALL_PHASES.indexOf(phase as never);
      // npm backend:node 与包一条命令一起装。mise 把 `node` 当**安装依赖**,它没装好就直接
      // 拒绝装包(实测:「requires configured install dependency 'node@…', but its selected
      // version is not installed」)—— 所以 node 必须显式出现在这条命令里。
      const installArgs = distribution.kind === 'npm'
        ? ['install', 'node@' + distribution.node, tool + '@' + candidate]
        : ['install', tool + '@' + candidate];
      await run(installArgs, true, (line) => {
        const report = miseProgress(line, Date.now() - started);
        if (!report) return;
        if (lastPhase && phaseRank(report.phase) < phaseRank(lastPhase)) return;
        if (report.phase !== lastPhase || (report.bytesDone ?? 0) > lastBytes) touch();
        lastPhase = report.phase;
        lastBytes = report.bytesDone ?? lastBytes;
        progress(report);
      });
      clearTimeout(timer);
      // 取包那一段到这里为止:之后的失败(启动器写不进去、版本对不上)换源不会有任何不同。
      downloading = false;
      const installed = (await inventory()).find((entry) => entry.version === candidate && entry.installed);
      if (!installed) throw new Error('Mise did not report the requested installation');
      const installs = path.join(root, 'data', 'installs') + path.sep;
      const directory = path.resolve(installed.install_path);
      if (!directory.startsWith(installs)) throw new Error('Mise reported an installation outside its managed directory');
      let executable: string;
      let nodeBin: string | undefined;
      if (distribution.kind === 'npm') {
        executable = await resolveNpmExecutable(directory, target.binary);
        const node = (await inventory('node')).find((entry) => entry.version === distribution.node && entry.installed);
        if (!node) throw new Error('Mise did not report the node runtime this package runs on');
        const nodeRoot = path.resolve(node.install_path);
        if (!nodeRoot.startsWith(installs)) throw new Error('Mise reported a node runtime outside its managed directory');
        // Windows 的 node 发行包把 node.exe 放在根,别的平台放 bin/ —— 两处都试,都没有就报错。
        const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
        nodeBin = undefined;
        for (const dir of [path.join(nodeRoot, 'bin'), nodeRoot]) {
          try { await access(path.join(dir, nodeName)); nodeBin = dir; break; } catch { /* 下一个候选 */ }
        }
        if (!nodeBin) throw new Error('Managed node runtime has no ' + nodeName);
      } else {
        executable = path.join(directory, distribution.executable);
      }
      progress({ phase: 'verifying', elapsedMs: Date.now() - started });
      const probeEnv = nodeBin ? { ...env, PATH: nodeBin + path.delimiter + (env.PATH ?? '') } : env;
      // Windows 上 npm 装出来的入口是 `.cmd` 壳,Node 拒绝直接 spawn 它(#5719 家族),要经一层 cmd。
      // `execInProcessGroup` 里包壳走 `planDirectSpawn`(与运行时 spawn 同一份转义),超时/取消时整树停 ——
      // execFile 自带的超时只杀得到壳,真程序留成孤儿。
      // ❌ 从前这里手拼 `'"' + executable + '" --version'` 交给 execFile:Node 会把参数里的引号再转义一遍,
      //    cmd 收到的是 `\"C:\...\qwen.cmd\"`,报「系统找不到指定的路径」—— 装是装上了,验收那一步
      //    失败又被回滚,Windows 上所有走 npm 那条托管安装的家(Pi / Qwen …)全都装不上(w1 真机,2026-09-22)。
      if (distribution.kind === 'acp-registry') {
        // ACP 注册表那一形态 ❌ 不执行它验版本:没有确知的 `--version`,跑一次就是起一个服务
        // (antigravity 的 par 自带 Python 运行时,冷启动几秒)。能验的是「cmd 指的文件在、能执行」——
        // 版本号本身来自注册表、写进启动器的发行标记,与 mise 版本目录同源。
        await access(executable, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
          .catch(() => { throw new Error('Installed archive has no executable at ' + distribution.executable); });
      } else {
        const actual = await execInProcessGroup(executable, ['--version'], {
          env: probeEnv,
          signal,
          timeout: 15_000,
        });
        if (actual.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0] !== distribution.version) throw new Error('Installed executable version does not match the selected release');
      }
      signal.throwIfAborted();
      await mkdir(path.dirname(launcher), { recursive: true });
      // 换启动器之前记下它原来指着哪一版:那一版可能正被一条还开着的会话用着,收旧版本时留下它。
      const previousLauncher = await readFile(launcher, 'utf8').catch(() => '');
      const temporaryLauncher = path.join(work, 'launcher.tmp');
      await writeFile(temporaryLauncher, managedLauncher(executable, nodeBin, distribution.version, distribution.kind === 'npm' ? [] : distribution.args));
      await chmod(temporaryLauncher, 0o755);
      signal.throwIfAborted();
      await rename(temporaryLauncher, launcher);
      published = true;
      await pruneStaleVersions(previousLauncher);
      return ok();
    } catch (error) {
      let output = error instanceof Error ? error.message : String(error);
      let recoveryFailed = false;
      if (candidate && !candidateExisted && !published) {
        try { await run(['uninstall', tool + '@' + candidate], false); }
        catch (cleanupError) { recoveryFailed = true; output += '\nCleanup: ' + String(cleanupError); }
      }
      if (!published && previousConfig !== undefined) {
        try { await writeFile(config, previousConfig); }
        catch (restoreError) { recoveryFailed = true; output += '\nRestore configuration: ' + String(restoreError); }
      }
      const artifacts = recoveryFailed ? [{ path: work, bytes: null }] : undefined;
      const stage = downloading ? { stage: DOWNLOAD_STAGE } : {};
      const last = lastProgress();
      const at = last ? { lastProgress: last } : {};
      const type = context.signal?.aborted ? 'cancelled' : idle ? 'stalled' : 'command-failed';
      log.warn('[mise-installer] 安装没装成', { tool, type, lastProgress: last ?? null, error: String(error).slice(0, 300) });
      if (type === 'cancelled') return err({ type, message: 'Installation cancelled.', output, artifacts, ...at });
      if (type === 'stalled') return err({ type, message: 'Installation stopped making progress.', output, idleMs: IDLE_MS, artifacts, ...stage, ...at });
      return err({ type, message: 'Managed installation failed.', output, artifacts, ...stage, ...at });
    } finally {
      clearTimeout(timer);
      meter?.stop();
    }
  };
  let result = await perform();
  try { await releaseLock?.(); }
  catch (releaseError) {
    const detail = 'Could not release the installation lock: ' + String(releaseError);
    const artifacts = [{ path: work + '.lock', bytes: null }];
    result = result.success
      ? err({ type: 'command-failed', message: published ? 'The new installation is active; lock cleanup failed.' : 'Removal completed; lock cleanup failed.', output: (published ? 'The new installation is active. ' : 'Removal completed. ') + detail, artifacts })
      : err({ ...result.error, message: result.error.message + ' ' + detail,
        ...('output' in result.error ? { output: result.error.output + '\n' + detail, artifacts: [...(result.error.artifacts ?? []), ...artifacts] } : {}) });
  }
  return result;
}

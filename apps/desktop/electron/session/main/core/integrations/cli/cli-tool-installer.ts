import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { IntegrationCliTool } from '@gugu/session-plugins/integrations';
import JSZip from 'jszip';
import { log } from '@main/lib/logger';
import { resolvesInside } from '../../extensions/path-containment';
import { cliToolsRoot } from './cli-paths';
import { preinstalledCliDirectory, preinstalledCliVersions } from './cli-preinstalled';
import { DWS_LINUX_PRODUCT, installManagedProduct, managedProductRoot } from './cli-managed-products';
import { FEISHU_BINARY_SHA256, FEISHU_CLI_VERSION, FEISHU_SKILLS_COMMIT, feishuArchiveName } from './feishu-cli';
import { TMEET_BINARY, TMEET_SKILLS_COMMIT } from './tmeet-cli';
import {
  cliToolRecipe,
  currentCliPlatform,
  WECOM_SKILLS_COMMIT,
  type CliPackage,
  type CliPlatform,
} from './cli-tools';

const execFileAsync = promisify(execFile);

/**
 * 官方命令行装在咕咕自己的目录里:`<GUGU_HOME>/integration-tools/<工具>/<版本>/{bin,skills}`,
 * 登录态在 `<GUGU_HOME>/integration-tools/<工具>/home`。❌ 跑厂商的 npm 安装脚本(见 cli-tools.ts 顶上)。
 *
 * 只认 npm 上那一份发布包:先镜像(国内快)后官方,下载来的包按代码里钉的 sha512 核过才解
 * (cli-tools.ts 的 `CliPackage.integrity`);dws 包里还带各平台归档的 `checksums.txt`,归档再核一次 sha256。
 * 核不上 = 响亮失败,❌ 换一份接着装。
 */

export type InstalledCliTool = {
  tool: IntegrationCliTool;
  version: string;
  binPath: string;
  skillsDir: string;
  homeDir: string;
};

const NPM_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
export type CliInstallProgress = { phase: 'download' | 'install'; receivedBytes: number; totalBytes?: number; file?: string };
type ReportProgress = (progress: CliInstallProgress) => void;
const installProgress = new Map<IntegrationCliTool, CliInstallProgress>();
export function cliInstallProgress(tool: IntegrationCliTool): CliInstallProgress | undefined {
  return installProgress.get(tool);
}

/** 这个工具的登录态目录(断开 = 删掉它)。 */
export function cliToolHome(tool: IntegrationCliTool, guguHome?: string): string {
  return path.join(cliToolsRoot(guguHome), tool, 'home');
}

export function installedCliTool(tool: IntegrationCliTool, guguHome?: string): InstalledCliTool {
  const recipe = cliToolRecipe(tool);
  const localDir = path.join(cliToolsRoot(guguHome), tool, recipe.version);
  const dir = existsSync(path.join(localDir, '.complete')) ? localDir : preinstalledCliDirectory(recipe) ?? localDir;
  return {
    tool,
    version: recipe.version,
    binPath: path.join(dir, 'bin', recipe.bin),
    skillsDir: path.join(dir, 'skills'),
    homeDir: cliToolHome(tool, guguHome),
  };
}

/** 装完整了没有(`.complete` 是最后一步才写的)。 */
export function isCliToolInstalled(tool: IntegrationCliTool, guguHome?: string): boolean {
  return existsSync(path.join(path.dirname(installedCliTool(tool, guguHome).binPath), '..', '.complete'));
}

const installs = new Map<IntegrationCliTool, Promise<InstalledCliTool>>();

/** 这个工具此刻在不在装。 */
export function isCliToolInstalling(tool: IntegrationCliTool): boolean {
  return installs.has(tool);
}

/** 装好(已装就直接给);同一个工具同时只装一份。 */
export function ensureCliTool(tool: IntegrationCliTool): Promise<InstalledCliTool> {
  if (isCliToolInstalled(tool)) return Promise.resolve(installedCliTool(tool));
  let pending = installs.get(tool);
  if (!pending) {
    pending = install(tool).finally(() => installs.delete(tool));
    installs.set(tool, pending);
  }
  return pending;
}

async function install(tool: IntegrationCliTool): Promise<InstalledCliTool> {
  const report: ReportProgress = (progress) => installProgress.set(tool, progress);
  const recipe = cliToolRecipe(tool);
  const platform = currentCliPlatform();
  const target = installedCliTool(tool);
  const dir = path.dirname(path.dirname(target.binPath));
  const staging = `${dir}.staging-${process.pid}-${Date.now()}`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(path.join(staging, 'bin'), { recursive: true });
  await fs.mkdir(path.join(staging, 'skills'), { recursive: true });
  try {
    const managedRoot = managedProductRoot(tool, platform);
    const preinstalled = managedRoot ? undefined : preinstalledCliVersions(recipe);
    if (preinstalled) {
      // 云电脑本该用镜像里那份,却要下载:多半是客户端先升了版本、镜像还是旧的。留一句,查「为什么又在下载」。
      log.warn('Cloud computer has no preinstalled copy of this connector tool version; downloading it', {
        tool, version: recipe.version, preinstalledVersions: preinstalled.versions, root: preinstalled.root,
      });
    }
    if (managedRoot) {
      if (recipe.version !== DWS_LINUX_PRODUCT.version) throw new Error('Managed CLI product version does not match the release');
      await installManagedProduct(managedRoot, DWS_LINUX_PRODUCT, staging, report);
    } else {
      const packageDir = await downloadNpmPackage(recipe.binaryPackage(platform), path.join(staging, 'download'), report);
      if (tool === 'lark-cli') {
        await installFeishu(platform, staging, report);
      } else if (tool === 'dws') {
        await installDws(packageDir, platform, staging);
      } else if (tool === 'tmeet') {
        await fs.copyFile(path.join(packageDir, 'dist', TMEET_BINARY[platform]), path.join(staging, 'bin', recipe.bin));
        await installTmeetSkills(staging, report);
      } else {
        await fs.copyFile(path.join(packageDir, 'bin', recipe.bin), path.join(staging, 'bin', recipe.bin));
        await installWecomSkills(path.join(staging, 'skills'), path.join(staging, 'download'), report);
      }
    }
    report({ phase: 'install', receivedBytes: 0 });
    await fs.chmod(path.join(staging, 'bin', recipe.bin), 0o755);
    await fs.rm(path.join(staging, 'download'), { recursive: true, force: true });
    await fs.writeFile(path.join(staging, '.complete'), `${recipe.version}\n`);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(staging, dir);
    return target;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    installProgress.delete(tool);
  }
}

/** 官方 release 的二进制与同一 tag 的 Skills；不运行 npm 的安装脚本。 */
async function installFeishu(platform: CliPlatform, staging: string, report: ReportProgress): Promise<void> {
  const archiveName = feishuArchiveName(platform);
  const archive = path.join(staging, 'download', archiveName);
  const digest = await downloadTo(
    `https://github.com/larksuite/cli/releases/download/v${FEISHU_CLI_VERSION}/${archiveName}`,
    archive, 'sha256', 'hex', report
  );
  if (digest !== FEISHU_BINARY_SHA256[platform]) throw new Error(`${archiveName} integrity mismatch`);
  await execFileAsync('tar', ['-xzf', archive, '-C', path.join(staging, 'bin'), 'lark-cli']);
  const sourceArchive = path.join(staging, 'download', 'source.tgz');
  await downloadTo(`https://codeload.github.com/larksuite/cli/tar.gz/${FEISHU_SKILLS_COMMIT}`, sourceArchive, 'sha256', 'hex', report);
  const source = path.join(staging, 'download', 'source');
  await fs.mkdir(source, { recursive: true });
  await execFileAsync('tar', ['-xzf', sourceArchive, '-C', source, '--strip-components', '1']);
  const skills = (await fs.readdir(path.join(source, 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('lark-'));
  if (!skills.some((entry) => entry.name === 'lark-shared')) throw new Error('lark-cli release has no lark-shared skill');
  for (const skill of skills) {
    await fs.cp(path.join(source, 'skills', skill.name), path.join(staging, 'skills', skill.name), { recursive: true });
  }
}

/** 下载一个 npm 包、按钉住的 integrity 核过、解开;返回解出来的 `package/` 目录。 */
async function downloadNpmPackage(pkg: CliPackage, workDir: string, report: ReportProgress, stallMs = CLI_DOWNLOAD_STALL_MS): Promise<string> {
  await fs.mkdir(workDir, { recursive: true });
  const failures: string[] = [];
  for (const registry of NPM_REGISTRIES) {
    try {
      const metadataUrl = `${registry}/${encodeURIComponent(pkg.name).replace(/^%40/, '@')}/${pkg.version}`;
      const metadata = (await fetchJson(metadataUrl, stallMs)) as {
        dist?: { tarball?: unknown };
      };
      const tarball = metadata.dist?.tarball;
      if (typeof tarball !== 'string') throw new Error(`${metadataUrl} has no tarball`);
      const archive = path.join(workDir, 'package.tgz');
      const digest = await downloadTo(tarball, archive, 'sha512', 'base64', report, { stallMs });
      if (`sha512-${digest}` !== pkg.integrity) {
        throw new Error(`${tarball} is not the ${pkg.name}@${pkg.version} gugu expects (integrity mismatch)`);
      }
      await execFileAsync('tar', ['-xzf', archive, '-C', workDir]);
      await fs.rm(archive, { force: true });
      return path.join(workDir, 'package');
    } catch (error) {
      failures.push(`${registry}: ${(error as Error).message}`);
    }
  }
  throw new Error(`Could not download ${pkg.name}@${pkg.version}. ${failures.join('; ')}`);
}

/** 多久没收到新字节就算卡住。只按这个判、❌ 按总时长判:国内云上拉 GitHub 只有几十 KB/s,十几 MB 要下十来分钟,得让它下完。 */
export const CLI_DOWNLOAD_STALL_MS = 60_000;

class DownloadStalledError extends Error {
  constructor(file: string, stallMs: number) {
    super(`Download of ${file} stalled: no data for ${Math.round(stallMs / 1000)} s.`);
    this.name = 'DownloadStalledError';
  }
}

/** 一个看门狗:`kick()` 一次就重新计时;到点没人 kick 就以「卡住」中止 `signal`。 */
function stallWatch(file: string, stallMs: number) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DownloadStalledError(file, stallMs)), stallMs);
  };
  kick();
  return { signal: controller.signal, kick, stop: () => clearTimeout(timer) };
}

async function fetchOk(url: string, signal: AbortSignal, headers?: Record<string, string>): Promise<Response> {
  const response = await fetch(url, { signal, ...(headers ? { headers } : {}) });
  if (!response.ok || !response.body) throw new DownloadHttpError(url, response.status);
  return response;
}

async function fetchJson(url: string, stallMs: number): Promise<unknown> {
  const watch = stallWatch(path.basename(new URL(url).pathname), stallMs);
  try {
    return await (await fetchOk(url, watch.signal)).json();
  } catch (error) {
    throw watch.signal.aborted ? watch.signal.reason : error;
  } finally {
    watch.stop();
  }
}

async function installTmeetSkills(staging: string, report: ReportProgress): Promise<void> {
  const archive = path.join(staging, 'download', 'tmeet-source.tgz');
  await downloadTo(`https://codeload.github.com/TencentCloud/tencentmeeting-cli/tar.gz/${TMEET_SKILLS_COMMIT}`, archive, 'sha256', 'hex', report);
  const source = path.join(staging, 'download', 'tmeet-source');
  await fs.mkdir(source, { recursive: true });
  await execFileAsync('tar', ['-xzf', archive, '-C', source, '--strip-components', '1']);
  const skill = path.join(source, 'skills', 'tmeet-skill');
  await fs.access(path.join(skill, 'SKILL.md'));
  await fs.cp(skill, path.join(staging, 'skills', 'tmeet-skill'), { recursive: true });
}

/** 中途断了(对端关连接、卡住、5xx)最多下几次。国内云上慢链路一下十来分钟,中途断一次很常见。 */
export const CLI_DOWNLOAD_ATTEMPTS = 4;

class DownloadHttpError extends Error {
  constructor(url: string, readonly status: number) {
    super(`${url} answered ${status}`);
    this.name = 'DownloadHttpError';
  }
}

/** 4xx(429 除外)是这个地址本身不对,再下也一样;别的(断流、卡住、5xx)多半下一次就好。 */
function retriesDownload(error: unknown): boolean {
  return !(error instanceof DownloadHttpError && error.status >= 400 && error.status < 500 && error.status !== 429);
}

export interface DownloadOptions {
  /** 多久没进新字节算卡住。 */
  stallMs?: number;
  attempts?: number;
  /** 第 n 次重下前等 `retryDelayMs * n`。 */
  retryDelayMs?: number;
}

/**
 * 边下边算摘要;返回摘要(按 `encoding`)。`stallMs` 没进新字节就以「卡住」失败,慢但在动的下载照样下完。
 * 中途断了就再下:服务器认 Range 就从断处接着下(❌ 十几 MB 从头再等十分钟),不认就从头。
 */
export async function downloadTo(
  url: string,
  file: string,
  algorithm: 'sha256' | 'sha512',
  encoding: 'hex' | 'base64',
  report: ReportProgress,
  { stallMs = CLI_DOWNLOAD_STALL_MS, attempts = CLI_DOWNLOAD_ATTEMPTS, retryDelayMs = 2_000 }: DownloadOptions = {},
): Promise<string> {
  const fileName = path.basename(new URL(url).pathname);
  let resumable = false;
  for (let attempt = 1; ; attempt += 1) {
    const offset = resumable ? await fs.stat(file).then((stat) => stat.size, () => 0) : 0;
    const watch = stallWatch(fileName, stallMs);
    try {
      return await downloadWatched(url, file, algorithm, encoding, report, watch, offset, (value) => (resumable = value));
    } catch (thrown) {
      const error = watch.signal.aborted ? watch.signal.reason : thrown;
      if (attempt >= attempts || !retriesDownload(error)) throw error;
      log.warn('Connector tool download broke off; downloading again', {
        file: fileName,
        attempt,
        resumeFrom: resumable ? await fs.stat(file).then((stat) => stat.size, () => 0) : 0,
        error,
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    } finally {
      watch.stop();
    }
  }
}

async function downloadWatched(
  url: string,
  file: string,
  algorithm: 'sha256' | 'sha512',
  encoding: 'hex' | 'base64',
  report: ReportProgress,
  watch: ReturnType<typeof stallWatch>,
  offset: number,
  setResumable: (resumable: boolean) => void,
): Promise<string> {
  const response = await fetchOk(url, watch.signal, offset > 0 ? { range: `bytes=${offset}-` } : undefined);
  watch.kick();
  const resumed = offset > 0 && response.status === 206;
  const encoded = Boolean(response.headers.get('content-encoding'));
  setResumable(!encoded && response.headers.get('accept-ranges') === 'bytes');
  const length = Number(response.headers.get('content-length'));
  const totalBytes = !encoded && Number.isSafeInteger(length) && length > 0 ? (resumed ? offset : 0) + length : undefined;
  const fileName = path.basename(new URL(url).pathname);
  const hash = createHash(algorithm);
  // 接着下:摘要得从文件开头算,先把已下的那段喂进去。
  if (resumed) hash.update(await fs.readFile(file));
  let receivedBytes = resumed ? offset : 0;
  const progress = () => report({ phase: 'download', receivedBytes, ...(totalBytes ? { totalBytes } : {}), file: fileName });
  progress();
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      receivedBytes += chunk.length;
      watch.kick();
      progress();
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    hashing,
    createWriteStream(file, { flags: resumed ? 'a' : 'w' }),
    { signal: watch.signal }
  );
  return hash.digest(encoding);
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

/** dws 的 npm 包:`assets/` 里各平台归档 + `checksums.txt` + `dws-skills.zip`。 */
async function installDws(packageDir: string, platform: CliPlatform, staging: string): Promise<void> {
  const assets = path.join(packageDir, 'assets');
  const [os, arch] = platform.split('-') as [string, string];
  const archiveName = `dws-${os}-${arch === 'x64' ? 'amd64' : arch}.tar.gz`;
  const checksums = await fs.readFile(path.join(assets, 'checksums.txt'), 'utf8');
  const expected = checksums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archiveName)?.[0];
  if (!expected) throw new Error(`dws checksums.txt does not list ${archiveName}`);
  const archive = path.join(assets, archiveName);
  if ((await sha256File(archive)) !== expected) throw new Error(`${archiveName} does not match dws checksums.txt`);
  await execFileAsync('tar', ['-xzf', archive, '-C', path.join(staging, 'bin')]);
  if (!existsSync(path.join(staging, 'bin', 'dws'))) throw new Error(`${archiveName} has no dws program`);

  // 只要单技能那一套(`mono/`,一个 `dws` skill + 它的参考文档),不要按产品拆开的几十个。
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(assets, 'dws-skills.zip')));
  const skillDir = path.join(staging, 'skills', 'dws');
  await fs.mkdir(skillDir, { recursive: true });
  let wrote = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.startsWith('mono/')) continue;
    const destination = resolvesInside(skillDir, entry.name.slice('mono/'.length));
    if (!destination) throw new Error(`dws-skills.zip has an entry outside its folder: ${entry.name}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, await entry.async('nodebuffer'));
    wrote += 1;
  }
  if (wrote === 0 || !existsSync(path.join(skillDir, 'SKILL.md'))) {
    throw new Error('dws-skills.zip has no mono/SKILL.md');
  }
}

/** wecom-cli 的 skills 只在它的源码仓里:钉到一个提交,取 `skills/wecomcli-*`。 */
async function installWecomSkills(skillsDir: string, workDir: string, report: ReportProgress): Promise<void> {
  const archive = path.join(workDir, 'wecom-cli-source.tgz');
  // 摘要不核(见 WECOM_SKILLS_COMMIT):内容由提交号定死。
  await downloadTo(`https://codeload.github.com/WecomTeam/wecom-cli/tar.gz/${WECOM_SKILLS_COMMIT}`, archive, 'sha256', 'hex', report);
  const source = path.join(workDir, 'source');
  await fs.mkdir(source, { recursive: true });
  await execFileAsync('tar', ['-xzf', archive, '-C', source, '--strip-components', '1']);
  const folders = (await fs.readdir(path.join(source, 'skills'), { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith('wecomcli-')
  );
  if (folders.length === 0) throw new Error(`wecom-cli ${WECOM_SKILLS_COMMIT} has no skills/wecomcli-* folders`);
  for (const folder of folders) {
    await fs.cp(path.join(source, 'skills', folder.name), path.join(skillsDir, folder.name), { recursive: true });
  }
}

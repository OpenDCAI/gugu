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
import { resolvesInside } from '../../extensions/path-containment';
import { cliToolsRoot } from './cli-paths';
import { preinstalledCliDirectory } from './cli-preinstalled';
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
async function downloadNpmPackage(pkg: CliPackage, workDir: string, report: ReportProgress): Promise<string> {
  await fs.mkdir(workDir, { recursive: true });
  const failures: string[] = [];
  for (const registry of NPM_REGISTRIES) {
    try {
      const metadataUrl = `${registry}/${encodeURIComponent(pkg.name).replace(/^%40/, '@')}/${pkg.version}`;
      const metadata = (await fetchOk(metadataUrl).then((response) => response.json())) as {
        dist?: { tarball?: unknown };
      };
      const tarball = metadata.dist?.tarball;
      if (typeof tarball !== 'string') throw new Error(`${metadataUrl} has no tarball`);
      const archive = path.join(workDir, 'package.tgz');
      const digest = await downloadTo(tarball, archive, 'sha512', 'base64', report);
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

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
  return response;
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

/** 边下边算摘要;返回摘要(按 `encoding`)。 */
async function downloadTo(
  url: string,
  file: string,
  algorithm: 'sha256' | 'sha512',
  encoding: 'hex' | 'base64',
  report: ReportProgress,
): Promise<string> {
  const response = await fetchOk(url);
  const length = Number(response.headers.get('content-length'));
  const totalBytes = !response.headers.get('content-encoding') && Number.isSafeInteger(length) && length > 0 ? length : undefined;
  const fileName = path.basename(new URL(url).pathname);
  let receivedBytes = 0;
  const progress = () => report({ phase: 'download', receivedBytes, ...(totalBytes ? { totalBytes } : {}), file: fileName });
  progress();
  const hash = createHash(algorithm);
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      receivedBytes += chunk.length;
      progress();
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    hashing,
    createWriteStream(file)
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

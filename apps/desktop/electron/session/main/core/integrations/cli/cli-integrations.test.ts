import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliIntegrationPathEnv, cliLauncherDir } from './cli-paths';
import { cliMethodOf, connectedCliSkills, publishCliLauncher, removeCliLauncher } from './cli-integrations';
import { installedCliTool } from './cli-tool-installer';
import { cliToolRecipe, currentCliPlatform } from './cli-tools';

let guguHome: string;
const previousHome = process.env.GUGU_HOME;

beforeEach(() => {
  // 路径里故意带单引号和空格:启动器脚本的引号要经得起。
  guguHome = mkdtempSync(path.join(tmpdir(), "gugu cli 'home' "));
  process.env.GUGU_HOME = guguHome;
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (previousHome === undefined) delete process.env.GUGU_HOME;
  else process.env.GUGU_HOME = previousHome;
  rmSync(guguHome, { recursive: true, force: true });
});

/** 在咕咕的目录里放一份「装好了」的 dws:一个打印自己环境和参数的假程序,加一份 skill。 */
function installFakeDws(skill = '---\nname: dws\ndescription: 用 dws 操作钉钉\n---\n# dws\n') {
  const installed = installedCliTool('dws');
  mkdirSync(path.dirname(installed.binPath), { recursive: true });
  writeFileSync(installed.binPath, '#!/bin/sh\necho "home=$HOME keychain=$DWS_DISABLE_KEYCHAIN args=$*"\n');
  chmodSync(installed.binPath, 0o755);
  mkdirSync(path.join(installed.skillsDir, 'dws'), { recursive: true });
  writeFileSync(path.join(installed.skillsDir, 'dws', 'SKILL.md'), skill);
  writeFileSync(path.join(path.dirname(installed.binPath), '..', '.complete'), 'test\n');
  return installed;
}

describe('agent 敲的那个命令(启动器)', () => {
  it('连上后:PATH 最前面多一个目录,里面的 dws 带着咕咕给它的登录态目录跑真程序', async () => {
    const installed = installFakeDws();
    expect(cliIntegrationPathEnv('/usr/bin:/bin')).toEqual({});

    await publishCliLauncher(cliToolRecipe('dws'), installed);
    const env = cliIntegrationPathEnv('/usr/bin:/bin', ':');
    expect(env.PATH).toBe(`${cliLauncherDir()}:/usr/bin:/bin`);

    const out = execFileSync('dws', ['contact', 'search', "it's me"], { env: { ...process.env, PATH: env.PATH }, encoding: 'utf8' });
    expect(out.trim()).toBe(`home=${installed.homeDir} keychain=1 args=contact search it's me`);
  });

  it('同一脚本没有变化时保留修改时间', async () => {
    const installed = installFakeDws();
    await publishCliLauncher(cliToolRecipe('dws'), installed);
    const file = path.join(cliLauncherDir(), 'dws');
    utimesSync(file, 1000, 1000);
    await publishCliLauncher(cliToolRecipe('dws'), installed);
    expect(statSync(file).mtimeMs).toBe(1000000);
  });

  it('断开后:命令从 PATH 上没了', async () => {
    const installed = installFakeDws();
    await publishCliLauncher(cliToolRecipe('dws'), installed);
    await removeCliLauncher(cliToolRecipe('dws'));
    expect(existsSync(path.join(cliLauncherDir(), 'dws'))).toBe(false);
  });
});

describe('connectedCliSkills —— 连上的官方命令行带的 skills 进会话', () => {
  it('连着且装好 → 钉钉的 dws skill,记在 dingtalk 名下', async () => {
    const installed = installFakeDws();
    const skills = await connectedCliSkills(async (id) => id === 'dingtalk', () => {});
    expect(skills).toEqual([
      { extensionId: 'dingtalk', name: 'dws', description: '用 dws 操作钉钉', dir: path.join(installed.skillsDir, 'dws') },
    ]);
  });

  it('恢复已连接集成时重建旧启动器，从 PATH 使用预装程序并保留原授权 HOME', async () => {
    const installed = installFakeDws();
    await publishCliLauncher(cliToolRecipe('dws'), installed);
    rmSync(path.dirname(path.dirname(installed.binPath)), { recursive: true });
    const cache = path.join(guguHome, 'preinstalled');
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '1');
    vi.stubEnv('GUGU_CLI_PREINSTALL_ROOT', cache);
    const dir = path.join(cache, 'dws', cliToolRecipe('dws').version);
    mkdirSync(path.join(dir, 'bin'), { recursive: true });
    mkdirSync(path.join(dir, 'skills'), { recursive: true });
    writeFileSync(path.join(dir, 'bin/dws'), '#!/bin/sh\necho "preinstalled home=$HOME keychain=$DWS_DISABLE_KEYCHAIN args=$*"\n', { mode: 0o755 });
    writeFileSync(path.join(dir, '.complete'), cliToolRecipe('dws').version);
    writeFileSync(path.join(dir, '.platform'), currentCliPlatform());
    const env = { ...process.env, PATH: cliIntegrationPathEnv('/usr/bin:/bin', ':').PATH };
    expect(() => execFileSync('dws', ['auth', 'status'], { env, stdio: 'pipe' })).toThrow();
    await connectedCliSkills(async id => id === 'dingtalk', () => {});
    const out = execFileSync('dws', ['auth', 'status'], { env, encoding: 'utf8' });
    expect(out.trim()).toBe(`preinstalled home=${installed.homeDir} keychain=1 args=auth status`);
  });

  it('没连 → 没有(装着也不给)', async () => {
    installFakeDws();
    await expect(connectedCliSkills(async () => false, () => {})).resolves.toEqual([]);
  });

  it('记着连着、程序却不在 → 不给,并且说出来', async () => {
    const onProblem = vi.fn();
    await expect(connectedCliSkills(async (id) => id === 'dingtalk', onProblem)).resolves.toEqual([]);
    expect(onProblem).toHaveBeenCalledWith(expect.stringContaining('dws is connected but not installed'));
  });

  it('skill 写坏了只丢它自己,会话照开', async () => {
    installFakeDws('---\nname: dws\n---\nno description\n');
    const onProblem = vi.fn();
    await expect(connectedCliSkills(async (id) => id === 'dingtalk', onProblem)).resolves.toEqual([]);
    expect(onProblem).toHaveBeenCalledWith(expect.stringContaining('skill dws left out'));
  });
});

describe('哪几家走官方命令行', () => {
  it('钉钉 → dws(设备链接,带管理员先决条件);企业微信 → wecom-cli(扫码);飞书 → lark-cli', () => {
    expect(cliMethodOf('dingtalk')).toMatchObject({ tool: 'dws', login: 'device-link', prerequisite: { url: 'https://open-dev.dingtalk.com' } });
    expect(cliMethodOf('wecom')).toMatchObject({ tool: 'wecom-cli', login: 'qr-code' });
    expect(cliMethodOf('feishu')).toMatchObject({ tool: 'lark-cli', login: 'qr-code' });
  });
});

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outputTail, readCliLoginStatus, startCliLogin } from './cli-login';
import type { InstalledCliTool } from './cli-tool-installer';
import { cliToolRecipe, wecomQrPath } from './cli-tools';

/**
 * 真起进程:用一个假的 `dws` / `wecom-cli`(sh 脚本)按真工具的样子打字、写二维码、退出,
 * 看登录这一段把「给人看的那一下」取出来、等到它退出、取消得掉、读得出「还登着吗」。
 */

let dir: string;
let home: string;
let work: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gugu-cli-login-'));
  home = path.join(dir, 'home');
  work = path.join(dir, 'work');
  for (const folder of [home, work]) mkdirSync(folder);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeTool(body: string): InstalledCliTool & { tool: 'dws' } {
  const binPath = path.join(dir, 'fake-tool');
  writeFileSync(binPath, `#!/bin/sh\n${body}\n`);
  chmodSync(binPath, 0o755);
  return { tool: 'dws', version: 'test', binPath, skillsDir: path.join(dir, 'skills'), homeDir: home };
}

const DEVICE_LINES = [
  '  authorization code: QHNK-DVQS',
  '  Authorization link (code included):',
  'https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&callerUmt=UMT&user_code=QHNK-DVQS',
];

describe('startCliLogin', () => {
  it('dws:授权链接打出来就给;对方确认后进程退出 0;跑的时候 HOME 是咕咕给它的目录', async () => {
    const installed = fakeTool(
      [...DEVICE_LINES.map((line) => `echo '${line}'`), 'echo "home=$HOME keychain=$DWS_DISABLE_KEYCHAIN"', 'sleep 0.3', 'exit 0'].join('\n')
    );
    const run = startCliLogin(cliToolRecipe('dws'), installed, work);
    await expect(run.prompt).resolves.toEqual({
      kind: 'device-link',
      url: DEVICE_LINES[2],
      code: 'QHNK-DVQS',
    });
    const outcome = await run.done;
    expect(outcome).toMatchObject({ kind: 'exited', code: 0 });
    expect(outcome.output).toContain(`home=${home} keychain=1`);
  });

  it('没打出链接就退了 → 说它最后说了什么(❌ 一直转圈)', async () => {
    const installed = fakeTool(`echo 'Error: organization has not enabled CLI access' >&2\nexit 3`);
    const run = startCliLogin(cliToolRecipe('dws'), installed, work);
    await expect(run.prompt).rejects.toThrow('organization has not enabled CLI access');
    await expect(run.done).resolves.toMatchObject({ kind: 'exited', code: 3 });
  });

  it('wecom-cli:等它说「二维码已保存到 <路径>」再读那张图;链接一并带上', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const pngFile = path.join(dir, 'source.png');
    writeFileSync(pngFile, png);
    const installed = { ...fakeTool(''), tool: 'wecom-cli' as const };
    writeFileSync(
      installed.binPath,
      [
        '#!/bin/sh',
        // 真工具:`--output-qrcode` 后面那个参数就是要写的文件。
        'out=""; while [ $# -gt 0 ]; do [ "$1" = "--output-qrcode" ] && out="$2"; shift; done',
        "echo '请打开二维码链接扫码: '",
        "echo 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=abc'",
        `cp '${pngFile}' "$out"`,
        'echo "二维码已保存到: $out"',
        'echo "config=$WECOM_CLI_CONFIG_DIR"',
        'sleep 0.2',
      ].join('\n')
    );
    const run = startCliLogin(cliToolRecipe('wecom-cli'), installed, work);
    await expect(run.prompt).resolves.toEqual({
      kind: 'qr-code',
      image: `data:image/png;base64,${png.toString('base64')}`,
      url: 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=abc',
    });
    const outcome = await run.done;
    expect(outcome.output).toContain(`二维码已保存到: ${wecomQrPath(work)}`);
    expect(outcome.output).toContain(`config=${path.join(home, 'config')}`);
  });

  it('取消 = 进程被结束,结果是 cancelled(不是「失败退出」)', async () => {
    const installed = fakeTool([...DEVICE_LINES.map((line) => `echo '${line}'`), 'sleep 30'].join('\n'));
    const run = startCliLogin(cliToolRecipe('dws'), installed, work);
    await run.prompt;
    const cancelledAt = Date.now();
    run.cancel();
    await expect(run.done).resolves.toMatchObject({ kind: 'cancelled' });
    // 连它起的子进程(sleep 30)一起结束:不等那 30 秒。
    expect(Date.now() - cancelledAt).toBeLessThan(5_000);
  });

  it('等到超时 → timed-out,进程被结束', async () => {
    const installed = fakeTool([...DEVICE_LINES.map((line) => `echo '${line}'`), 'sleep 30'].join('\n'));
    const run = startCliLogin({ ...cliToolRecipe('dws'), loginTimeoutMs: 2_000 }, installed, work);
    // 计时从起进程算。机器忙到两秒内连链接都没打出来,提示会先落空 —— 结局照样是超时,❌ 因此判红。
    run.prompt.catch(() => {});
    await expect(run.done).resolves.toMatchObject({ kind: 'timed-out' });
  });
});

describe('readCliLoginStatus', () => {
  it('按工具自己的回答:登着 / 没登', async () => {
    const recipe = cliToolRecipe('dws');
    await expect(readCliLoginStatus(recipe, fakeTool(`echo '{"success":true,"authenticated":true}'`))).resolves.toBe(true);
    await expect(readCliLoginStatus(recipe, fakeTool(`echo '{"success":true,"authenticated":false}'`))).resolves.toBe(false);
  });

  it('答不出来 → 抛错,带上它的话(❌ 当成没登)', async () => {
    await expect(
      readCliLoginStatus(cliToolRecipe('dws'), fakeTool(`echo 'segfault' >&2\nexit 2`))
    ).rejects.toThrow(/exit 2[\s\S]*segfault/);
  });
});

describe('outputTail', () => {
  it('去掉终端颜色和二维码字符画,留最后几行', () => {
    expect(outputTail('\u001b[31mError\u001b[0m: denied\n    █▀▀▀▀▀█ █▄▄\n\nlast line\n')).toBe('Error: denied\nlast line');
  });
});

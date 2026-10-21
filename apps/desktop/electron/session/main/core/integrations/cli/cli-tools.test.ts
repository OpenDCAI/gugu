import { describe, expect, it } from 'vitest';
import { cliToolRecipe, currentCliPlatform, parseDwsDevicePrompt, parseWecomQrUrl } from './cli-tools';

/** dws 1.0.64 `auth login --device` 真打出来的那一段(2026-10-15 在 MBP 上跑的,callerUmt 换成了占位)。 */
const DWS_DEVICE_OUTPUT = `● Step 1: Requesting device authorization code...

  authorization code: QHNK-DVQS
  Authorization code will expire in 900 seconds.

  Authorization link (code included):
https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&callerUmt=UMT&user_code=QHNK-DVQS

  Link for entering the code manually:
https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&callerUmt=UMT

● Step 2: Waiting for user authorization...
  (polling every 5 seconds)
`;

/** wecom-cli 1.3.4 `auth init --noninteractive --no-browser --output-qrcode <png>` 真打出来的(二维码字符画截短)。 */
const WECOM_QR_OUTPUT = `┌  企业微信机器人配置
│
正在获取二维码...
请打开二维码链接扫码:
https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=0NDN4lsQ8guKF-13
也可以使用企业微信扫描以下二维码：

    █▀▀▀▀▀█ █▄▄▀▀▀▀█▄▄▀▀▀▄▄██ █  ▀█▀█ █▀▀▀▀▀█
    ▀▀▀▀▀▀▀ ▀       ▀▀▀  ▀▀ ▀▀    ▀▀▀▀▀  ▀ ▀

二维码已保存到: /tmp/login/login-qrcode.png
等待扫码中...
`;

describe('官方命令行登录时打出来的那一下', () => {
  it('dws:取带授权码的那条链接,不取「手动输入授权码」那条', () => {
    expect(parseDwsDevicePrompt(DWS_DEVICE_OUTPUT)).toEqual({
      kind: 'device-link',
      url: 'https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&callerUmt=UMT&user_code=QHNK-DVQS',
      code: 'QHNK-DVQS',
    });
  });

  it('dws:授权码那行先出来、链接还没出来 → 接着等(null),❌ 拿一半去显示', () => {
    const firstLines = DWS_DEVICE_OUTPUT.slice(0, DWS_DEVICE_OUTPUT.indexOf('https://'));
    expect(firstLines).toContain('QHNK-DVQS');
    expect(parseDwsDevicePrompt(firstLines)).toBeNull();
    expect(parseDwsDevicePrompt('https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&callerUmt=UMT\n')).toBeNull();
  });

  it('wecom-cli:二维码同一个去处的那条链接', () => {
    expect(parseWecomQrUrl(WECOM_QR_OUTPUT)).toBe(
      'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=0NDN4lsQ8guKF-13'
    );
    expect(parseWecomQrUrl('正在获取二维码...\n')).toBeUndefined();
  });
});

describe('问工具「还登着吗」的读法', () => {
  const dws = cliToolRecipe('dws');
  const wecom = cliToolRecipe('wecom-cli');

  it('dws:读 authenticated(真输出带着 version_check 等别的格)', () => {
    const real = (authenticated: boolean) =>
      JSON.stringify({ version_check: { current: 'v1.0.64' }, success: true, authenticated, message: '未登录' });
    expect(dws.parseStatus(real(false))).toBe(false);
    expect(dws.parseStatus(real(true))).toBe(true);
  });

  it('dws:读不懂就抛,❌ 当成未登录', () => {
    expect(() => dws.parseStatus('{"success":false}')).toThrow(/did not say/);
    expect(() => dws.parseStatus('panic: something')).toThrow();
  });

  it('wecom-cli:authorized / unauthorized,别的抛', () => {
    expect(wecom.parseStatus('authorized\n')).toBe(true);
    expect(wecom.parseStatus('unauthorized\n')).toBe(false);
    expect(() => wecom.parseStatus('error: config broken')).toThrow(/config broken/);
  });

  it('登录态关进咕咕给的目录:dws 用 HOME + 关钥匙串,wecom-cli 用它的配置目录变量', () => {
    expect(dws.env('/g/home')).toEqual({ HOME: '/g/home', DWS_DISABLE_KEYCHAIN: '1' });
    expect(wecom.env('/g/home')).toEqual({ WECOM_CLI_CONFIG_DIR: '/g/home/config' });
  });
});

describe('平台', () => {
  it('mac / linux 的两种架构可装;Windows 响亮地说不支持', () => {
    expect(currentCliPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(currentCliPlatform('linux', 'x64')).toBe('linux-x64');
    expect(() => currentCliPlatform('win32', 'x64')).toThrow(/not available on win32/);
  });

  it('wecom-cli 按平台取它那个程序包;dws 一个包带全平台', () => {
    expect(cliToolRecipe('wecom-cli').binaryPackage('linux-arm64')).toMatchObject({ name: '@wecom/cli-linux-arm64', version: '1.3.4' });
    expect(cliToolRecipe('dws').binaryPackage('linux-arm64')).toMatchObject({ name: 'dingtalk-workspace-cli', version: '1.0.64' });
  });

  it('每个平台的包都钉着自己的 sha512(❌ 信镜像回的那一个)', () => {
    const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const;
    const wecom = platforms.map((platform) => cliToolRecipe('wecom-cli').binaryPackage(platform).integrity);
    for (const integrity of [...wecom, cliToolRecipe('dws').binaryPackage('darwin-arm64').integrity]) {
      expect(integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
    expect(new Set(wecom).size).toBe(4);
  });
});

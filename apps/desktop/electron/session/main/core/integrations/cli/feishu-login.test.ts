import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFeishuStatus, feishuCliRecipe } from './feishu-cli';
import { feishuVerificationUrl, startFeishuLogin, verifyFeishuLogin, feishuAuthorizationCompleted } from './feishu-login';
import type { InstalledCliTool } from './cli-tool-installer';
import { provider } from '../../../../../../../../packages/session-plugins/src/integrations/impl/feishu';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'feishu-login-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fakeTool(configured = false): InstalledCliTool {
  const homeDir = path.join(root, 'home');
  mkdirSync(path.join(homeDir, 'config'), { recursive: true });
  if (configured) writeFileSync(path.join(homeDir, 'config', 'config.json'), '{}');
  const binPath = path.join(root, 'lark-cli');
  writeFileSync(binPath, `#!/bin/sh
echo "$1 $2" >> "$HOME/calls"
case "$1 $2" in
  'config init')
    echo 'https://open.feishu.cn/page/cli?user_code=CONFIG&from=cli' >&2
    while [ ! -f "$HOME/approve-config" ]; do sleep 0.05; done
    echo '{}' > "$LARKSUITE_CLI_CONFIG_DIR/config.json"
    ;;
  'auth login')
    echo '{"event":"device_authorization","verification_uri_complete":"https://accounts.feishu.cn/oauth/verify?code=USER&x=1","user_code":"USER"}'
    while [ ! -f "$HOME/approve-user" ]; do sleep 0.05; done
    if [ -f "$HOME/partial" ]; then
      echo '{"event":"authorization_complete","user_open_id":"ou_test","warning":{"type":"missing_scope"}}'
      exit 3
    fi
    ;;
  'auth qrcode')
    printf 'png' > "$5"
    ;;
  'auth status')
    verified=true
    [ -f "$HOME/revoked" ] && verified=false
    printf '{"identity":"user","verified":%s,"identities":{"user":{"available":true,"status":"ready","verified":%s}}}' "$verified" "$verified"
    ;;
esac
`);
  chmodSync(binPath, 0o755);
  return { tool: 'lark-cli', version: 'test', binPath, skillsDir: path.join(root, 'skills'), homeDir };
}

describe('飞书个人账号状态', () => {
  const status = (identity: string, available: boolean, state = 'ready', verified?: boolean) =>
    JSON.stringify({ identity, identities: { user: { available, status: state, verified } } });
  it('用户可用与只有机器人可用分开判', () => {
    expect(parseFeishuStatus(status('user', true))).toBe(true);
    expect(parseFeishuStatus(status('bot', false, 'missing'))).toBe(false);
    expect(parseFeishuStatus(status('user', true, 'ready', false))).toBe(false);
    expect(parseFeishuStatus(status('user', true, 'needs_refresh'))).toBe(true);
  });
  it('仪器没读懂或出错时抛错，不能当作未连接', () => {
    expect(() => parseFeishuStatus('{}')).toThrow('user identity');
    expect(() => parseFeishuStatus(status('none', false, 'error'))).toThrow();
    expect(() => parseFeishuStatus(status('user', true, 'future-status'))).toThrow('Unknown');
  });
  it('旧 MCP 凭据不冒充 CLI 连接', async () => {
    const auth = provider.behavior.auth!;
    expect(await auth.verify({ log: {} } as never, { tokens: { access_token: 'old' } } as never)).toMatchObject({ connected: false });
    expect(await auth.verify({ log: {} } as never, { tool: 'lark-cli', connectedAt: 1 })).toEqual({ connected: true });
  });
  it('配置和密文存储都隔离在咕咕给的 home 内', () => {
    expect(feishuCliRecipe.env('/isolated')).toMatchObject({
      HOME: '/isolated', LARKSUITE_CLI_CONFIG_DIR: '/isolated/config', LARKSUITE_CLI_DATA_DIR: '/isolated/data',
    });
  });
  it('登录后验证要求服务端确认，不能仅凭本地有用户令牌就算通过', async () => {
    const installed = fakeTool(true);
    expect(await verifyFeishuLogin(installed)).toBe(true);
    writeFileSync(path.join(installed.homeDir, 'revoked'), '');
    expect(await verifyFeishuLogin(installed)).toBe(false);
  });
});

describe('两阶段授权', () => {
  it('Exit 3 只有明确完成个人授权事件才可进入服务端验证', () => {
    expect(feishuAuthorizationCompleted('{"event":"authorization_complete","user_open_id":"ou_test","warning":{"type":"missing_scope"}}')).toBe(true);
    expect(feishuAuthorizationCompleted('{"ok":false,"error":{"subtype":"missing_scope"}}')).toBe(false);
    expect(feishuAuthorizationCompleted('{"event":"authorization_complete","warning":{"type":"missing_scope"}}')).toBe(false);
  });
  it('用户只授予部分权限时保留成功登录结果，宿主随后仍要验证令牌', async () => {
    const installed = fakeTool(true);
    writeFileSync(path.join(installed.homeDir, 'partial'), '');
    const run = startFeishuLogin(installed, root);
    try {
      await run.prompt;
      writeFileSync(path.join(installed.homeDir, 'approve-user'), '');
      await expect(run.done).resolves.toMatchObject({ kind: 'exited', code: 0 });
      expect(readFileSync(path.join(installed.homeDir, 'calls'), 'utf8')).toContain('config default-as');
    } finally { run.cancel(); await run.done; }
  });
  it('先配置应用，再更新成用户授权，完成两个步骤才结束', async () => {
    const installed = fakeTool();
    const run = startFeishuLogin(installed, root);
    try {
      await expect(run.prompt).resolves.toMatchObject({ kind: 'qr-code', url: expect.stringContaining('user_code=CONFIG') });
      expect(readFileSync(path.join(installed.homeDir, 'calls'), 'utf8')).not.toContain('auth login');
      writeFileSync(path.join(installed.homeDir, 'approve-config'), '');
      await vi.waitFor(() => expect(run.currentPrompt).toMatchObject({ url: expect.stringContaining('code=USER&x=1') }));
      writeFileSync(path.join(installed.homeDir, 'approve-user'), '');
      await expect(run.done).resolves.toMatchObject({ kind: 'exited', code: 0 });
    } finally { run.cancel(); await run.done; }
  });
  it('应用已配置时只做个人授权', async () => {
    const installed = fakeTool(true);
    const run = startFeishuLogin(installed, root);
    try {
      await expect(run.prompt).resolves.toMatchObject({ url: expect.stringContaining('code=USER') });
      expect(readFileSync(path.join(installed.homeDir, 'calls'), 'utf8')).not.toContain('config init');
    } finally { run.cancel(); await run.done; }
  });
  it('取消配置后不会偷偷继续用户授权', async () => {
    const installed = fakeTool();
    const run = startFeishuLogin(installed, root);
    await run.prompt;
    run.cancel();
    await expect(run.done).resolves.toMatchObject({ kind: 'cancelled' });
    expect(existsSync(path.join(installed.homeDir, 'config', 'config.json'))).toBe(false);
    expect(readFileSync(path.join(installed.homeDir, 'calls'), 'utf8')).not.toContain('auth login');
  });
  it('链接保留原始 query，不取帮助链接或不完整 JSON', () => {
    expect(feishuVerificationUrl('https://www.feishu.cn/help', 'configure')).toBeNull();
    expect(feishuVerificationUrl('{"event":"device_authorization"', 'authorize')).toBeNull();
    expect(() => feishuVerificationUrl('{"event":"device_authorization","verification_uri_complete":"https://evil.invalid/verify"}', 'authorize')).toThrow('unexpected authorization host');
  });
});

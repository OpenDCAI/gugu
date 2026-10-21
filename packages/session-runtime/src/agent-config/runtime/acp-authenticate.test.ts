import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deferred } from '@gugu/session-wire/testing';
import { describe, expect, it, vi } from 'vitest';
import { awaitPending, awaitReaped } from '../../../../../tests/support/awaitFact';
import { runAcpAuthenticate } from './acp-authenticate';

/**
 * 假 ACP 服务:按 MODE 回 initialize / authenticate,并把收到的请求逐行记进 LOG。
 *  · ok      —— 两个都回 result;authenticate 之前往 stderr 打一行带登录链接的话(照 agy_acp_server 原文)
 *  · reject  —— authenticate 回 -32000 + data.message
 *  · hang    —— authenticate 永不回包(等 OAuth 回调的形状),记下自己的 pid
 *  · die     —— initialize 之前就退出
 *  · notify  —— 登录链接只走协议通知 `_codebuddy.ai/authUrl {authUrl, provider}`(CodeBuddy 的形状),stderr 一个字都不打
 */
const FAKE = `
const fs = require('node:fs');
const mode = process.env.MODE; const log = process.env.LOG;
fs.appendFileSync(log, JSON.stringify({ pid: process.pid, browser: process.env.BROWSER ?? null }) + '\\n');
if (mode === 'die') process.exit(3);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    fs.appendFileSync(log, JSON.stringify({ method: m.method, params: m.params }) + '\\n');
    const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...body }) + '\\n');
    if (m.method === 'initialize') reply({ result: { protocolVersion: 1, authMethods: [] } });
    if (m.method === 'authenticate') {
      if (mode === 'notify') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: '_codebuddy.ai/authUrl', params: { authUrl: 'https://copilot.tencent.com/login?platform=CLI&state=s1', provider: 'external' } }) + '\\n');
        reply({ result: {} });
        continue;
      }
      process.stderr.write('Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?state=abc.\\n');
      if (mode === 'ok') reply({ result: {} });
      if (mode === 'reject') reply({ error: { code: -32000, message: 'Authentication failed', data: { message: 'bad code' } } });
    }
  }
});
`;

const dir = mkdtempSync(join(tmpdir(), 'acp-authenticate-test-'));
const script = join(dir, 'fake-acp.cjs');
writeFileSync(script, FAKE);

function spawnSpec(mode: string, log: string) {
  return {
    command: process.execPath,
    args: [script],
    env: { PATH: process.env.PATH ?? '', MODE: mode, LOG: log },
    cwd: dir,
  };
}

function readLog(log: string): Record<string, unknown>[] {
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('runAcpAuthenticate', () => {
  it('initialize → authenticate {methodId} → succeeded;stderr 里的登录链接交出来(去掉句尾标点)', async () => {
    const log = join(dir, 'ok.log');
    const urls: string[] = [];
    // stderr 与 stdout 是两根管子:回包先到时,登录链接可能还在 stderr 上没读到 —— 等 onUrl 本身。
    const urlSurfaced = deferred();
    const outcome = await runAcpAuthenticate({
      spawn: spawnSpec('ok', log),
      methodId: 'oauth-personal',
      signal: new AbortController().signal,
      onUrl: (url) => {
        urls.push(url);
        urlSurfaced.resolve();
      },
    });
    expect(outcome).toEqual({ kind: 'succeeded' });
    const entries = readLog(log);
    expect(entries.map((entry) => entry.method).filter(Boolean)).toEqual(['initialize', 'authenticate']);
    expect(entries.find((entry) => entry.method === 'authenticate')?.params).toEqual({ methodId: 'oauth-personal' });
    // 用户亲手点的登录:❌ 不许带模型目录探针那条 BROWSER 屏蔽。
    expect(entries[0]?.browser).toBeNull();
    await awaitPending('login link surfaced through onUrl', urlSurfaced.promise);
    expect(urls).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?state=abc']);
  });

  it('登录链接只走协议通知(CodeBuddy 的 _codebuddy.ai/authUrl)⇒ 照样交出来当备用链接', async () => {
    const log = join(dir, 'notify.log');
    const urls: string[] = [];
    const outcome = await runAcpAuthenticate({
      spawn: spawnSpec('notify', log),
      methodId: 'internal',
      signal: new AbortController().signal,
      onUrl: (url) => urls.push(url),
    });
    expect(outcome).toEqual({ kind: 'succeeded' });
    // 通知在回包之前、同一根 stdout 上,按顺序读到 ⇒ 回包到时链接已经交出。
    expect(urls).toEqual(['https://copilot.tencent.com/login?platform=CLI&state=s1']);
  });

  it('authenticate 回错误 ⇒ failed,带上厂商原话', async () => {
    const outcome = await runAcpAuthenticate({
      spawn: spawnSpec('reject', join(dir, 'reject.log')),
      methodId: 'oauth-personal',
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ kind: 'failed', message: 'authenticate: Authentication failed — bad code' });
  });

  it('进程在握手前退出 ⇒ failed(不挂着)', async () => {
    const outcome = await runAcpAuthenticate({
      spawn: spawnSpec('die', join(dir, 'die.log')),
      methodId: 'oauth-personal',
      signal: new AbortController().signal,
    });
    expect(outcome.kind).toBe('failed');
  });

  it('等回调期间用户取消 ⇒ cancelled,且进程被收掉', async () => {
    const log = join(dir, 'cancel.log');
    const controller = new AbortController();
    // 假服务收到 authenticate 时往 stderr 打登录链接:onUrl 到了,就是「正挂在等回调」。
    const authenticating = deferred();
    const running = runAcpAuthenticate({
      spawn: spawnSpec('hang', log),
      methodId: 'oauth-personal',
      signal: controller.signal,
      onUrl: () => authenticating.resolve(),
    });
    await awaitPending('fake ACP server received authenticate', authenticating.promise);
    expect(readLog(log).some((entry) => entry.method === 'authenticate')).toBe(true);
    const pid = readLog(log)[0]?.pid as number;
    controller.abort();
    await expect(running).resolves.toEqual({ kind: 'cancelled' });
    await awaitReaped('fake ACP server reaped after cancel', [pid]);
  });

  it('浏览器那一侧一直不回来 ⇒ 超时 failed,进程同样被收掉', async () => {
    const log = join(dir, 'timeout.log');
    // 超时是被测对象:走假时钟,等假服务真的挂在 authenticate 上之后才推过它 —— 超时不会先于子进程起来。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const authenticating = deferred();
      const running = runAcpAuthenticate({
        spawn: spawnSpec('hang', log),
        methodId: 'oauth-personal',
        signal: new AbortController().signal,
        timeoutMs: 1_500,
        onUrl: () => authenticating.resolve(),
      });
      await awaitPending('fake ACP server received authenticate', authenticating.promise);
      await vi.advanceTimersByTimeAsync(1_500);
      // 收进程树(owned.stop)自己的轮询间隔不是这里的被测对象,交回真时钟。
      vi.useRealTimers();
      const outcome = await running;
      expect(outcome).toEqual({ kind: 'failed', message: '登录超时:浏览器那一侧一直没有完成授权。' });
      const pid = readLog(log)[0]?.pid as number;
      await awaitReaped('fake ACP server reaped after timeout', [pid]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('开始前就已取消 ⇒ 不起进程', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAcpAuthenticate({
        spawn: spawnSpec('ok', join(dir, 'never.log')),
        methodId: 'oauth-personal',
        signal: controller.signal,
      })
    ).resolves.toEqual({ kind: 'cancelled' });
  });
});

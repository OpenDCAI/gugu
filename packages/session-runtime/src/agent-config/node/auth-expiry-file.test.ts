import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthExpiryMarks } from '../runtime/auth-expiry';
import { homeKeyedAuthExpiryPersistence } from './auth-expiry-file';

// #6264 同一台机器上两个咕咕账号:claude 共用这个 Linux 用户的 ~/.claude,codex 各有各的影子 home。
describe('「登录已失效」按「这台机器 × 配置家」记', () => {
  let dir: string;
  let file: string;
  const accountA = (id: string) => (id === 'codex' ? `codex|/srv/A/agent-homes/codex` : `${id}|/home/u`);
  const accountB = (id: string) => (id === 'codex' ? `codex|/srv/B/agent-homes/codex` : `${id}|/home/u`);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-expiry-'));
    file = path.join(dir, 'agent-auth-expiry.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('A 发现共用的 claude 登录过期 ⇒ B 读到的也是过期;A 的 codex 过期 ❌ 串到 B', async () => {
    const a = new AuthExpiryMarks(homeKeyedAuthExpiryPersistence(file, accountA));
    const b = new AuthExpiryMarks(homeKeyedAuthExpiryPersistence(file, accountB));
    await Promise.all([a.ready, b.ready]);
    a.mark('claude', 1);
    a.mark('codex', 2);
    await a.flushed();
    await b.reload();
    expect(b.has('claude')).toBe(true);
    expect(b.has('codex')).toBe(false);

    // B 那边 claude 又能用了 ⇒ 撤掉;A 再读就恢复。A 自己的 codex 标记不被 B 的写盘冲掉。
    b.clear('claude');
    await b.flushed();
    await a.reload();
    expect(a.has('claude')).toBe(false);
    expect(a.has('codex')).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { expired: Record<string, number> };
    expect(onDisk.expired).toEqual({ 'codex|/srv/A/agent-homes/codex': 2 });
  });

  it('老格式(只有 providerId,按账号存的)照样读得出来', async () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, expired: { claude: 5 } }));
    const a = new AuthExpiryMarks(homeKeyedAuthExpiryPersistence(file, accountA));
    await a.ready;
    expect(a.has('claude')).toBe(true);
  });
});

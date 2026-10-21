import { beforeEach, describe, expect, it } from 'vitest';
import { GitHubAccountReconciliationService } from './github-account-reconciliation';
import type { GitHubAccount } from './github-accounts';

function account(id: string, credentialSource: GitHubAccount['credentialSource']): GitHubAccount {
  return {
    id,
    providerAccountId: id.split(':')[1] ?? id,
    host: id.split(':')[0] ?? 'github.com',
    login: id,
    avatarUrl: '',
    credentialSource,
    connectedAt: 1,
    updatedAt: 1,
  };
}

class CliImporter {
  result: GitHubAccount[] = [account('github.com:42', 'cli'), account('github.com:84', 'cli')];
  error: Error | null = null;

  constructor(private readonly calls: string[]) {}

  async importAccounts() {
    this.calls.push('cli');
    if (this.error) throw this.error;
    return this.result;
  }
}

class WarningLogger {
  warnings: Array<{ message: string; context: Record<string, unknown> }> = [];

  warn(message: string, context: Record<string, unknown>) {
    this.warnings.push({ message, context });
  }
}

describe('GitHubAccountReconciliationService', () => {
  let cliImporter: CliImporter;
  let logger: WarningLogger;
  let calls: string[];
  let service: GitHubAccountReconciliationService;

  beforeEach(() => {
    calls = [];
    cliImporter = new CliImporter(calls);
    logger = new WarningLogger();
    service = new GitHubAccountReconciliationService({
      cliImporter,
      logger,
    });
  });

  it('imports GitHub CLI accounts', async () => {
    const result = await service.reconcile();

    expect(calls).toEqual(['cli']);
    expect(result).toEqual({ importedCliAccountIds: ['github.com:42', 'github.com:84'] });
    expect(logger.warnings).toEqual([]);
  });

  it('keeps startup running when GitHub CLI import fails', async () => {
    cliImporter.error = new Error('gh unavailable');

    await expect(service.reconcile()).resolves.toEqual({ importedCliAccountIds: [] });
    expect(logger.warnings).toEqual([
      {
        message: 'Failed to import GitHub CLI accounts during startup',
        context: { error: 'gh unavailable' },
      },
    ]);
  });
  // @@@3130 惰性入口:UI 每次读账号都会调它,但底层导入整个进程只该跑一次。
  // 反向对照见下一条 —— 去掉 memo 化后这条会红。
  it('reconcileOnce 反复调用只跑一次底层导入', async () => {
    const [a, b, c] = await Promise.all([
      service.reconcileOnce(),
      service.reconcileOnce(),
      service.reconcileOnce(),
    ]);

    expect(calls).toEqual(['cli']);
    expect(a).toBe(b);
    expect(b).toBe(c);

    await service.reconcileOnce();
    expect(calls).toEqual(['cli']);
  });

  // 对照:直接调 reconcile() 每次都真跑 —— 证明上一条测的是 memo 化本身,不是「碰巧只跑一次」。
  it('reconcile 每次调用都真跑(上一条的判假对照)', async () => {
    await service.reconcile();
    await service.reconcile();

    expect(calls).toEqual(['cli', 'cli']);
  });
});

import type { GitHubAccount } from './github-accounts';

type CliAccountImporter = {
  importAccounts(): Promise<GitHubAccount[]>;
};

type WarningLogger = {
  warn(message: string, context: Record<string, unknown>): void;
};

export type GitHubAccountReconciliationResult = {
  importedCliAccountIds: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GitHubAccountReconciliationService {
  constructor(
    private readonly deps: {
      cliImporter: CliAccountImporter;
      logger: WarningLogger;
    }
  ) {}

  private inFlight: Promise<GitHubAccountReconciliationResult> | null = null;

  // @@@3130 惰性入口:只在 UI 第一次真要读 GitHub 账号时跑,且整个进程只跑一次。
  //
  // ❌ 别挪回开机。导入只要碰到已有数据就会写加密存储 → Electron safeStorage → macOS 钥匙串,
  // 而全新 profile 上 app_secrets 是空的:用户还没登录就被系统要**开机密码**,一个聊天客户端刚
  // 打开就问系统密码,观感上像在要不该要的权限。beta 是 ad-hoc 签名(cdhash 每次构建都变、钥匙串
  // ACL 认不出是同一个 app),所以每出一个新构建都会再问一次。
  //
  // 失败不缓存:reconcile() 自己 try/catch 不会 reject,但万一将来变了,这里清掉 inFlight
  // 让下次调用重试,而不是把一个 rejected promise 永久钉在这。
  reconcileOnce(): Promise<GitHubAccountReconciliationResult> {
    this.inFlight ??= this.reconcile().catch((error: unknown) => {
      this.inFlight = null;
      throw error;
    });
    return this.inFlight;
  }

  async reconcile(): Promise<GitHubAccountReconciliationResult> {
    const cliAccounts = await this.importCliAccounts();

    return {
      importedCliAccountIds: [...new Set(cliAccounts.map((account) => account.id))],
    };
  }

  private async importCliAccounts(): Promise<GitHubAccount[]> {
    try {
      return await this.deps.cliImporter.importAccounts();
    } catch (error) {
      this.deps.logger.warn('Failed to import GitHub CLI accounts during startup', {
        error: errorMessage(error),
      });
      return [];
    }
  }
}

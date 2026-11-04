import type { AgentAuthStatus, HarnessModelCredentialStatus } from '@gugu/session-core/agents/plugins';

/**
 * #6264「登录已失效」—— 这台机器上哪几家 harness 的登录最近一次真用时被拒了。
 *
 * # 为什么要有这一格
 *
 * 各家 CLI 自己的「登没登」只看凭据文件在不在:codex `login status` 读 `auth.json` 就答
 * 「Logged in using ChatGPT」、退出码 0,**不联网**(`codex-rs/cli/src/login.rs` 的 `run_login_status`);
 * claude `auth status` 文档只说「Exits with code 0 if logged in, 1 if not」(code.claude.com/docs/en/cli-reference)。
 * refresh token 过期或被撤销时文件还在,两家都照答「已登录」,而会话一开口就被拒 ——
 * d22 真机:`auth.json` 在、`login status` 说已登录,会话报「Your access token could not be refreshed」。
 *
 * 能判出「已失效」的只有真用过它的那一侧(会话)。所以:会话被结构化的鉴权错误拒了 ⇒ 标上;
 * 这台机器上重新登录成功、或之后这家有一次会话成功 ⇒ 撤掉(与 VS Code / GitHub Copilot
 * 「鉴权失败后账号显示需重新登录」同一个形状)。
 *
 * ❌ 不用 codex app-server 的 `account/read { refreshToken: true }` 去主动验:它会**真的换发一次**
 * refresh token,而 codex 自己的文档写着两个持有者抢同一个 refresh token 会让另一个报
 * `refresh_token_reused`(`codex-rs/login/src/auth/manager.rs`)—— 为了看一眼状态把用户别处开着的
 * codex 登出,比显示一个旧读数更糟。
 */

/** 落盘接口 —— 生产里是 worker 数据目录下一个小 JSON;不给 = 只在内存里(测试、独立跑的工具)。 */
export interface AuthExpiryPersistence {
  load(): Promise<Record<string, number>>;
  save(marks: Record<string, number>): Promise<void>;
}

export class AuthExpiryMarks {
  private readonly marks = new Map<string, number>();
  private saving: Promise<void> = Promise.resolve();
  /** 读盘完成;之前 `has()` 答 false(与「没标过」一样,不会把人说成失效)。 */
  readonly ready: Promise<void>;

  constructor(
    private readonly persistence: AuthExpiryPersistence | null = null,
    private readonly onError: (error: unknown) => void = () => {}
  ) {
    this.ready = persistence
      ? persistence
          .load()
          .then((loaded) => {
            for (const [providerId, at] of Object.entries(loaded)) {
              if (typeof at === 'number' && !this.marks.has(providerId)) this.marks.set(providerId, at);
            }
          })
          .catch((error) => this.onError(error))
      : Promise.resolve();
  }

  has(providerId: string): boolean {
    return this.marks.has(providerId);
  }

  providers(): string[] {
    return [...this.marks.keys()];
  }

  /** 标上;已经标着返回 false(不重复写盘)。 */
  mark(providerId: string, at: number): boolean {
    if (this.marks.has(providerId)) return false;
    this.marks.set(providerId, at);
    this.persist();
    return true;
  }

  /** 撤掉;本来就没标返回 false —— 调用方据此决定要不要重新读一次登录态。 */
  clear(providerId: string): boolean {
    if (!this.marks.delete(providerId)) return false;
    this.persist();
    return true;
  }

  /**
   * 重新读一次盘(#6264):同一台机器上别的咕咕账号的会话可能刚标上 / 撤掉了**共用的那份登录**
   * (claude 的真 `~/.claude`),读数要跟上。只替换自己这几家的读数;读失败保持原样(❌ 把人说成失效或恢复)。
   * 小 JSON 一次读,只在有人来读登录态时调用(用户打开相关界面 / 起会话前),❌ 定时轮询。
   */
  async reload(): Promise<void> {
    if (!this.persistence) return;
    await this.ready;
    await this.saving;
    try {
      const loaded = await this.persistence.load();
      this.marks.clear();
      for (const [providerId, at] of Object.entries(loaded)) if (typeof at === 'number') this.marks.set(providerId, at);
    } catch (error) {
      this.onError(error);
    }
  }

  /** 等最近一次写盘落定(测试用,也给退出前收尾)。 */
  flushed(): Promise<void> {
    return this.saving;
  }

  private persist(): void {
    if (!this.persistence) return;
    const snapshot = Object.fromEntries(this.marks);
    const persistence = this.persistence;
    // 串行写:后一次一定覆盖前一次,❌ 两次并发写出一个旧快照。
    this.saving = this.saving.then(() => persistence.save(snapshot)).catch((error) => this.onError(error));
  }
}

/**
 * 把 CLI 自己的读数与「登录已失效」合起来。
 *
 * CLI 答「已登录」或「判不出」而这家被标着 ⇒ 登录已失效。CLI 自己都说没登录时照它说
 * (那是更直接的事实:用户退出登录了 / 文件没了),不再叠「失效」。
 *
 * ⚠️ 凭据是**用户自己递进来的**(`credentialKind: 'api-key'`)时也不叠(#1163)。这一格说的是
 * 「这份 Anthropic 登录不能用了,去重新登录」—— 而这类用户手上没有可续的登录:钥匙是他在咕咕之外
 * 自己管的(控制台 key / cc-switch 一类中转的令牌),被拒说明那把钥匙或它指的服务此刻不认他。
 * 借这一格说那件事,错的还不只是措辞:界面把唯一动作换成「重新登录」(一条他没有的路),他自家的
 * 模型清单也一起被顶掉(见 `withAuthExpiry`)。凭据被拒这件事由**那一轮会话自己**说,❌ 不借这一格。
 */
export function applyAuthExpiry(status: AgentAuthStatus, expired: boolean): AgentAuthStatus {
  if (!expired || status.kind === 'unauthenticated') return status;
  if (status.kind === 'authenticated' && status.credentialKind === 'api-key') return status;
  return { kind: 'unauthenticated', reason: 'expired' };
}

/** 模型清单那一组(「你的 X 模型」)的凭据读数:登录已失效 ⇒ 没有可用凭据,默认挪到咕咕的模型上。 */
export function applyCredentialExpiry(
  credential: HarnessModelCredentialStatus,
  expired: boolean
): HarnessModelCredentialStatus {
  return expired ? 'uncredentialed' : credential;
}

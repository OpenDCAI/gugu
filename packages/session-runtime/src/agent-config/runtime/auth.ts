import { randomUUID } from 'node:crypto';
import { agentRunContextKey, type AgentRunContext } from '@gugu/session-core/acp';
import type { AgentAuthStatus, AgentHostError } from '@gugu/session-core/agents/plugins';
import { PtyRegistry, type PtyExitInfo, type PtySession } from '@gugu/session-core/pty';
import type { AgentConfigAuthError, AuthStatusModelState } from '@gugu/session-core/workspace-server';
import { err, ok, type PendingLease, type Result } from '@gugu/session-shared';
import type { LiveLog } from '@gugu/session-wire';
import {
  createManagedSource,
  deduplicateRequests,
  type ManagedSource,
  type Scope,
} from '@gugu/session-wire/util';
import { applyAuthExpiry, AuthExpiryMarks } from './auth-expiry';
import type { AgentInstallManager } from './install';
import type { AgentConfigRuntimeDeps } from './types';
import { runAcpAuthenticate, type AcpAuthenticateOptions } from './acp-authenticate';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
/**
 * 终端颜色控制序列(CSI / OSC)。登录命令给链接上色(codex `--device-auth` 印的是
 * `ESC[94mhttps://auth.openai.com/codex/deviceESC[0m`),不先剥掉,链接尾巴会带着 `ESC[0m`
 * 被交给浏览器(#6264 走查机上实测读到的正是这一串)。
 */
const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/**
 * 一趟登录 / 一份读数的键 —— 「哪一家 × 哪个程序」(#6335)。主程序就是 providerId 本身
 * (与改之前逐字节一致);伴随程序另占一格,两个程序的登录进程与读数互不顶替。
 */
export function authKey(providerId: string, program: string | undefined, connectionId?: string): string {
  const key = program === undefined ? providerId : `${providerId}\u0000${program}`;
  return connectionId ? `${key}\u0000connection:${connectionId}` : key;
}

type LoginContext = {
  providerId: string;
  /** 登哪个程序;缺席 = 主程序。 */
  program: string | undefined;
  connectionId?: string;
  methodId: string;
  generation: string;
  /**
   * 这次登录跑的那份 CLI(宿主定,#5683)。登录结束后的状态刷新**必须量同一份**:
   * 登进哪个账号由它决定,换一份去问答的就是另一个账号。
   */
  runContext: AgentRunContext;
  /** #6264 从别的电脑发起:跑这家的 `headlessArgs`(见 plugin-host `buildLoginCommand`)。 */
  headless: boolean;
};

/**
 * 一趟登录。两种形态,由这家声明的登录方法决定(capabilities `auth.methods[].kind`):
 *  · `cli-login` —— 一个终端(`pty`)跑 `<cli> login`;
 *  · `acp-authenticate` —— 起它的 ACP 进程发 `authenticate`(`acp`),浏览器由厂商自己拉起,没有终端。
 * ⚠️ 同一张账(`loginLeases` / `login` 状态 / 取消 / 结束后重读登录态),❌ 不另起一套平行的登录面。
 */
type LoginSession = {
  providerId: string;
  program: string | undefined;
  connectionId?: string;
  generation: string;
  pty: PtySession | null;
  acp: { abort: AbortController } | null;
  seenUrls: Set<string>;
};

type LoginLease = {
  generation: string;
  lease: PendingLease<LoginSession>;
};

type StatusProbe = {
  providerId: string;
  program: string | undefined;
  connectionId?: string;
  runContext: AgentRunContext;
};

export class AgentAuthManager {
  private readonly scope: Scope;
  private readonly statusGenerations = new Map<string, number>();
  private readonly ptys: PtyRegistry;
  private readonly loginSource: ManagedSource<string, LoginSession, LoginContext>;
  private readonly loginLeases = new Map<string, LoginLease>();
  private readonly probeStatus: (input: StatusProbe) => Promise<AgentAuthStatus>;
  /** #6264「登录已失效」标记 —— 见 `auth-expiry.ts`。 */
  readonly expiry: AuthExpiryMarks;
  /** 每家上一次读登录态用的那份 CLI —— 撤掉「登录已失效」后重读时量同一份。 */
  private readonly lastRunContext = new Map<string, AgentRunContext>();
  private readonly currentConnection = new Map<string, string>();

  constructor(
    private readonly deps: AgentConfigRuntimeDeps,
    private readonly install: AgentInstallManager
  ) {
    this.scope = deps.scope.child('auth');
    this.expiry = deps.authExpiry ?? new AuthExpiryMarks();
    // 上次运行留下的标记:读完盘就把这几家的读数先翻成「登录已失效」,❌ 等到有人来问才翻 ——
    // 界面订阅的是这份 live state,不是每次都探。
    void this.expiry.ready.then(() => {
      for (const providerId of this.expiry.providers()) {
        if (this.hasProvider(providerId)) this.publishExpiry(providerId);
      }
    });
    this.ptys = new PtyRegistry(deps.ptySpawner);
    // 键是 `authKey`(这一家 × 这个程序);上下文里带着拆开的 providerId / program。
    this.loginSource = createManagedSource<string, LoginSession, LoginContext>({
      key: (key) => key,
      scope: this.scope,
      label: 'login-source',
      create: (_key, context, scope) => this.createLoginSession(context, scope),
      onError: (error, key) => {
        deps.logger.warn('AgentAuthManager: login PTY creation failed', {
          key,
          error: errorMessage(error),
        });
      },
    });
    // 在途去重按「这一家 × 这个程序 × 这一份 CLI」:用户换了拷贝之后发起的那次,❌ 不许并进换之前那次的结果。
    this.probeStatus = deduplicateRequests(
      (input: StatusProbe) =>
        this.probeAndUpdate(input.providerId, input.program, input.runContext, input.connectionId),
      {
        key: (input) =>
          `${authKey(input.providerId, input.program, input.connectionId)}\u0000${agentRunContextKey(input.runContext)}`,
      }
    );
    this.scope.add(() => {
      this.loginLeases.clear();
      this.statusGenerations.clear();
      this.lastRunContext.clear();
      this.currentConnection.clear();
    });
  }

  async refreshAuthStatus(
    providerId: string,
    runContext: AgentRunContext,
    program?: string,
    connectionId?: string
  ): Promise<Result<AgentAuthStatus, AgentConfigAuthError>> {
    if (!this.hasProvider(providerId)) return err({ type: 'unknown-provider', providerId });
    // 失效标记只管主程序(#6264);换回它时要用上一次读数的那份 CLI。
    if (program === undefined) {
      this.lastRunContext.set(authExpiryKey(providerId, runContext.connectionId), runContext);
      if (!connectionId) this.currentConnection.set(providerId, runContext.connectionId ?? 'native');
    }
    return ok(await this.probeStatus({ providerId, program, connectionId, runContext }));
  }

  /**
   * 会话被鉴权拒了(#6264):标上「登录已失效」并立刻翻读数。❌ 不去探 CLI —— 它只会照文件答「已登录」。
   */
  async markExpired(providerId: string, connectionId?: string): Promise<Result<void, AgentConfigAuthError>> {
    if (!this.hasProvider(providerId)) return err({ type: 'unknown-provider', providerId });
    await this.expiry.ready;
    if (this.expiry.mark(authExpiryKey(providerId, connectionId), Date.now())) {
      this.deps.logger.info('AgentAuthManager: marked sign-in expired after an auth failure', { providerId });
    }
    this.publishExpiry(providerId, connectionId);
    return ok();
  }

  /**
   * 这家之后有一次会话成功了:撤掉标记,再按上一次读数用的那份 CLI 读一次真读数。本来没标 = 什么都不做。
   * 从没读过(没有那份 CLI 可量)就落回「还没读」—— 下一个来问的面会自己探。
   */
  async clearExpired(providerId: string, connectionId?: string): Promise<Result<void, AgentConfigAuthError>> {
    if (!this.hasProvider(providerId)) return err({ type: 'unknown-provider', providerId });
    await this.expiry.ready;
    if (!this.expiry.clear(authExpiryKey(providerId, connectionId))) return ok();
    this.deps.logger.info('AgentAuthManager: sign-in works again, expiry cleared', { providerId });
    const runContext = this.lastRunContext.get(authExpiryKey(providerId, connectionId));
    if (runContext) {
      const status = await this.probeStatus({ providerId, program: undefined, runContext, connectionId });
      if ((this.currentConnection.get(providerId) ?? 'native') === (connectionId ?? 'native')) {
        this.updateStatus(providerId, undefined, status);
      }
    } else
      this.publish(
        providerId,
        undefined,
        (current) => ({ ...current, status: { kind: 'unknown' } }),
        connectionId
      );
    return ok();
  }

  async startLogin(
    providerId: string,
    methodId: string,
    runContext: AgentRunContext,
    program?: string,
    options: { headless?: boolean } = {},
    connectionId?: string
  ): Promise<Result<void, AgentConfigAuthError>> {
    if (!this.hasProvider(providerId)) return err({ type: 'unknown-provider', providerId });
    const key = authKey(providerId, program, connectionId);
    await this.releaseLogin(key, undefined, { force: true });
    const generation = randomUUID();
    const lease = this.loginSource.acquire(key, {
      providerId,
      program,
      methodId,
      connectionId,
      generation,
      runContext,
      headless: options.headless === true,
    });
    this.loginLeases.set(key, { generation, lease });
    try {
      await lease.ready();
      if (!this.isCurrentLogin(key, generation)) {
        return err({ type: 'invalid-state', message: 'Login was superseded while starting' });
      }
      return ok();
    } catch (error) {
      if (this.isCurrentLogin(key, generation)) this.loginLeases.delete(key);
      await lease.release();
      return err({ type: 'invalid-state', message: errorMessage(error) });
    }
  }

  async cancelLogin(
    providerId: string,
    program?: string,
    connectionId?: string
  ): Promise<Result<void, AgentConfigAuthError>> {
    if (!this.hasProvider(providerId)) return err({ type: 'unknown-provider', providerId });
    // 协议登录那一趟:scope 收尾时 abort ⇒ runAcpAuthenticate 的 finally 收掉整个进程组。
    await this.releaseLogin(authKey(providerId, program, connectionId), undefined, { force: true });
    this.publish(providerId, program, (current) => ({ ...current, login: null }), connectionId);
    return ok();
  }

  sendLoginInput(
    providerId: string,
    data: string,
    program?: string,
    connectionId?: string
  ): Result<void, AgentConfigAuthError> {
    if (!this.hasProvider(providerId)) return err({ type: 'unknown-provider', providerId });
    const session = this.currentLogin(authKey(providerId, program, connectionId));
    if (!session?.pty) return noLogin(providerId);
    session.pty.write(data);
    return ok();
  }

  resizeLogin(
    providerId: string,
    cols: number,
    rows: number,
    program?: string,
    connectionId?: string
  ): Result<void, AgentConfigAuthError> {
    if (!this.hasProvider(providerId)) return err({ type: 'unknown-provider', providerId });
    const session = this.currentLogin(authKey(providerId, program, connectionId));
    if (!session?.pty) return noLogin(providerId);
    session.pty.resize(cols, rows);
    return ok();
  }

  markUrlHandled(
    providerId: string,
    urlId: string,
    program?: string,
    connectionId?: string
  ): Result<void, AgentConfigAuthError> {
    if (!this.hasProvider(providerId)) return err({ type: 'unknown-provider', providerId });
    this.publish(
      providerId,
      program,
      (current) => {
        if (current.login?.pendingUrl?.id !== urlId) return current;
        return {
          ...current,
          login: {
            ...current.login,
            pendingUrl: null,
          },
        };
      },
      connectionId
    );
    return ok();
  }

  loginOutput(providerId: string, program?: string, connectionId?: string): LiveLog | null {
    return this.currentLogin(authKey(providerId, program, connectionId))?.pty?.output ?? null;
  }

  dispose(): Promise<void> {
    return this.scope.dispose();
  }

  private async createLoginSession(context: LoginContext, scope: Scope): Promise<LoginSession> {
    const { providerId, program, connectionId } = context;
    const key = authKey(providerId, program, connectionId);
    if (this.acpAuthenticateMethodId(providerId, program, context.methodId) !== null) {
      return this.createAcpLoginSession(context, scope);
    }
    const loginCommand = await this.deps.agentHost.buildLoginCommand(
      providerId,
      context.methodId,
      context.runContext,
      program,
      { headless: context.headless }
    );
    if (!loginCommand.success) throw new Error(agentConfigAuthErrorMessage(loginCommand.error));
    const { command, args, env } = loginCommand.data;
    if (!this.isCurrentLogin(key, context.generation)) {
      throw new Error('Login was superseded while resolving the login command');
    }
    const startedAt = Date.now();
    const seenUrls = new Set<string>();
    this.publish(
      providerId,
      program,
      (current) => ({
        ...current,
        login: {
          methodId: context.methodId,
          startedAt,
          transport: 'terminal',
          pendingUrl: null,
          exit: null,
        },
      }),
      connectionId
    );

    // PTY chunks can split anywhere inside an OAuth query or an ANSI sequence.
    // Only scan completed lines, so a partial authorization URL is never offered to the user.
    let outputLine = '';
    const pty = await this.ptys.create(
      key,
      {
        command,
        args,
        cwd: this.deps.agentHost.homeDir,
        env,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      },
      {
        replaceExisting: false,
        onData: (chunk) => {
          outputLine += chunk;
          const end = Math.max(outputLine.lastIndexOf('\n'), outputLine.lastIndexOf('\r'));
          if (end < 0) return;
          this.detectUrl(context, seenUrls, outputLine.slice(0, end + 1));
          outputLine = outputLine.slice(end + 1);
        },
        onExit: (info) => {
          void this.handleLoginExit(context, info);
        },
      }
    );
    scope.add(() => {
      if (this.ptys.get(key) === pty) this.ptys.dispose(key);
    });
    return { providerId, program, connectionId, generation: context.generation, pty, acp: null, seenUrls };
  }

  /** 这家这个程序的这个方法若是协议登录,返回厂商自报的 `methodId`;否则 null(走终端那条)。 */
  private acpAuthenticateMethodId(
    providerId: string,
    program: string | undefined,
    methodId: string
  ): string | null {
    const auth = this.deps.agentHost.resolveProgramAuth(providerId, program);
    if (!auth.success || !auth.data) return null;
    const method = auth.data.methods.find((candidate) => candidate.id === methodId);
    return method?.kind === 'acp-authenticate' ? method.methodId : null;
  }

  /**
   * 协议登录那一趟(`acp-authenticate`)。
   *
   * 起进程**与真会话同一条** `buildAcpSpawn`(同一份可执行文件、同一份 env —— 含插件自己加的回环
   * NO_PROXY),所以登进去的就是会话会用的那个配置根。❌ 不加模型目录探针那条 `BROWSER` 屏蔽:
   * 这是用户亲手点的登录,浏览器就该弹出来。
   *
   * 结局写进 `login.outcome`;无论成败都重读一次登录态 —— 登没登上只有 harness 的凭据说了算。
   * 模型目录的强制重读由界面在关窗时做(`AgentAccountSection` 的 refreshAfterLogin),与终端登录同一条。
   */
  private async createAcpLoginSession(context: LoginContext, scope: Scope): Promise<LoginSession> {
    const { providerId, program, connectionId } = context;
    const key = authKey(providerId, program, connectionId);
    const upstreamMethodId = this.acpAuthenticateMethodId(providerId, program, context.methodId)!;
    const spawn = await this.deps.agentHost.buildAcpSpawn(providerId, {
      cwd: this.deps.agentHost.homeDir,
      runContext: context.runContext,
    });
    if (!spawn.success) throw new Error(agentConfigAuthErrorMessage(spawn.error));
    if (!this.isCurrentLogin(key, context.generation)) {
      throw new Error('Login was superseded while resolving the ACP spawn');
    }
    const abort = new AbortController();
    scope.add(() => abort.abort());
    const seenUrls = new Set<string>();
    this.publish(
      providerId,
      program,
      (current) => ({
        ...current,
        login: {
          methodId: context.methodId,
          startedAt: Date.now(),
          transport: 'acp-authenticate',
          pendingUrl: null,
          exit: null,
          outcome: null,
        },
      }),
      connectionId
    );
    const run = (this.runAcpAuthenticate ?? runAcpAuthenticate)({
      spawn: {
        command: spawn.data.command,
        args: spawn.data.args,
        env: spawn.data.env,
        cwd: spawn.data.cwd,
      },
      methodId: upstreamMethodId,
      signal: abort.signal,
      onUrl: (url) => this.detectUrl(context, seenUrls, url),
    });
    void run.then(
      (outcome) => this.handleAcpLoginOutcome(context, outcome),
      (error: unknown) =>
        this.handleAcpLoginOutcome(context, { kind: 'failed', message: errorMessage(error) })
    );
    return {
      providerId,
      program,
      connectionId,
      generation: context.generation,
      pty: null,
      acp: { abort },
      seenUrls,
    };
  }

  /** 测试注入口:换掉真正起进程的那一段。 */
  runAcpAuthenticate: ((options: AcpAuthenticateOptions) => ReturnType<typeof runAcpAuthenticate>) | null =
    null;

  private async handleAcpLoginOutcome(
    context: LoginContext,
    outcome: Awaited<ReturnType<typeof runAcpAuthenticate>>
  ): Promise<void> {
    const { providerId, program, generation, connectionId } = context;
    const key = authKey(providerId, program, connectionId);
    if (!this.isCurrentLogin(key, generation)) return;
    this.publish(
      providerId,
      program,
      (current) => (current.login ? { ...current, login: { ...current.login, outcome } } : current),
      connectionId
    );
    await this.releaseLogin(key, generation);
    if (this.scope.disposed || outcome.kind === 'cancelled') return;
    await this.probeStatus({ providerId, program, connectionId, runContext: context.runContext }).catch(
      (error) => {
        this.deps.logger.warn('AgentAuthManager: failed to refresh auth after ACP login', {
          providerId,
          error: errorMessage(error),
        });
      }
    );
  }

  private async handleLoginExit(context: LoginContext, info: PtyExitInfo): Promise<void> {
    const { providerId, program, generation, connectionId } = context;
    const key = authKey(providerId, program, connectionId);
    if (!this.isCurrentLogin(key, generation)) return;
    this.publishLoginExit(context, info);
    await this.releaseLogin(key, generation);
    if (this.scope.disposed) return;
    // 登录命令正常走完 = 这台机器上刚换上了一份新凭据 ⇒「登录已失效」到此为止,下面那次探测给的是真读数。
    // 非 0 退出(取消、失败)不撤:旧凭据还是那份坏的。失效标记只挂在主程序上(#6264)。
    if (
      program === undefined &&
      info.exitCode === 0 &&
      this.expiry.clear(authExpiryKey(providerId, context.runContext.connectionId))
    ) {
      this.deps.logger.info('AgentAuthManager: signed in again, expiry cleared', { providerId });
    }
    await this.probeStatus({ providerId, program, connectionId, runContext: context.runContext }).catch(
      (error) => {
        this.deps.logger.warn('AgentAuthManager: failed to refresh auth after login exit', {
          providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    );
  }

  private async releaseLogin(
    key: string,
    generation?: string,
    options: { force?: boolean } = {}
  ): Promise<void> {
    const entry = this.loginLeases.get(key);
    if (entry) {
      if (generation && entry.generation !== generation) return;
      this.loginLeases.delete(key);
      if (options.force) await this.loginSource.invalidate(key);
      await entry.lease.release();
      return;
    }

    if (!generation || options.force) await this.loginSource.invalidate(key);
  }

  private async probeAndUpdate(
    providerId: string,
    program: string | undefined,
    runContext: AgentRunContext,
    connectionId?: string
  ): Promise<AgentAuthStatus> {
    const key = authKey(providerId, program, connectionId);
    const generation = this.nextStatusGeneration(key);
    const status = await this.probe(providerId, program, runContext);
    const selected =
      !runContext.connectionId ||
      connectionId !== undefined ||
      this.currentConnection.get(providerId) === runContext.connectionId;
    if (!this.scope.disposed && this.statusGenerations.get(key) === generation && selected) {
      this.updateStatus(providerId, program, status, connectionId);
    }
    return status;
  }

  private async probe(
    providerId: string,
    program: string | undefined,
    runContext: AgentRunContext
  ): Promise<AgentAuthStatus> {
    try {
      const status = await this.deps.agentHost.checkAuthStatus(providerId, runContext, program);
      if (!status.success) {
        this.deps.logger.warn('AgentAuthManager: spawn context resolution failed', {
          providerId,
          program,
          error: agentConfigAuthErrorMessage(status.error),
        });
        return { kind: 'unknown' };
      }
      // 失效标记只挂在主程序上(#6264):伴随程序的读数照它自己的答。
      if (program !== undefined) return status.data;
      await this.expiry.reload();
      // 「登录已失效」的前提是凭据还在。CLI 自己说没登录(从没登上 / 退出了)⇒ 这一格不成立,连盘上的一起撤掉 ——
      // 留着,下次开机读数探到之前就先被说成「登录已失效」(10-07 mac1:没 key 的 MiMo、没登录的 Claude)。
      const key = authExpiryKey(providerId, runContext.connectionId);
      if (status.data.kind === 'unauthenticated') this.expiry.clear(key);
      // 另一半前提是这份凭据**是一份能续的登录**(#1163):用户自己递的 key / 中转令牌不是 —— 没有
      // 重新登录那条路可走。旧版本会在这种机器上留下标记(凭据被拒时标上,而之后没有任何一条路能撤),
      // 所以这里与上面那条同一个处置:前提不成立就撤掉,❌ 让它一直躺到用户换一份凭据。
      if (status.data.kind === 'authenticated' && status.data.credentialKind === 'api-key') {
        this.expiry.clear(key);
      }
      return applyAuthExpiry(status.data, this.expiry.has(key));
    } catch (error) {
      this.deps.logger.warn('AgentAuthManager: status probe failed', {
        providerId,
        error: errorMessage(error),
      });
      return { kind: 'unknown' };
    }
  }

  private detectUrl(context: LoginContext, seenUrls: Set<string>, chunk: string): void {
    const { providerId, program, generation, connectionId } = context;
    if (!this.isCurrentLogin(authKey(providerId, program, connectionId), generation)) return;
    const url = Array.from(chunk.replace(ANSI_PATTERN, '').matchAll(URL_PATTERN), (match) =>
      stripTrailingUrlPunctuation(match[0])
    ).find((candidate) => isAuthorizationUrl(candidate) && !seenUrls.has(candidate));
    if (!url) return;
    seenUrls.add(url);

    this.publish(
      providerId,
      program,
      (current) => {
        if (!current.login || current.login.pendingUrl) return current;
        return {
          ...current,
          login: {
            ...current.login,
            pendingUrl: { id: randomUUID(), url },
          },
        };
      },
      connectionId
    );
  }

  private publishLoginExit(context: LoginContext, exit: PtyExitInfo): void {
    const { providerId, program, generation, connectionId } = context;
    if (!this.isCurrentLogin(authKey(providerId, program, connectionId), generation)) return;
    this.publish(
      providerId,
      program,
      (current) => {
        if (!current.login) return current;
        return {
          ...current,
          login: {
            ...current.login,
            exit,
          },
        };
      },
      connectionId
    );
  }

  private updateStatus(
    providerId: string,
    program: string | undefined,
    status: AgentAuthStatus,
    connectionId?: string
  ): void {
    this.publish(
      providerId,
      program,
      (current) => ({
        status,
        login: status.kind === 'authenticated' ? null : current.login,
      }),
      connectionId
    );
  }

  private publishExpiry(providerId: string, connectionId?: string): void {
    const update = (current: AuthStatusModelState): AuthStatusModelState => ({
      ...current,
      status: applyAuthExpiry(current.status, this.expiry.has(authExpiryKey(providerId, connectionId))),
    });
    if (connectionId) this.publish(providerId, undefined, update, connectionId);
    const current = this.currentConnection.get(providerId) ?? 'native';
    if (current === (connectionId ?? 'native')) this.publish(providerId, undefined, update);
  }

  private publish(
    providerId: string,
    program: string | undefined,
    update: (current: AuthStatusModelState) => AuthStatusModelState,
    connectionId?: string
  ): void {
    if (this.scope.disposed) return;
    const current = this.install.getAuth(providerId, program, connectionId);
    this.install.updateAuth(providerId, update(current), program, connectionId);
  }

  private hasProvider(providerId: string): boolean {
    return this.deps.agentHost.get(providerId) !== undefined;
  }

  private currentLogin(key: string): LoginSession | null {
    const session = this.loginSource.peek(key);
    if (!session || !this.isCurrentLogin(key, session.generation)) return null;
    return session;
  }

  private isCurrentLogin(key: string, generation: string): boolean {
    return this.loginLeases.get(key)?.generation === generation;
  }

  private nextStatusGeneration(key: string): number {
    const next = (this.statusGenerations.get(key) ?? 0) + 1;
    this.statusGenerations.set(key, next);
    return next;
  }
}

function stripTrailingUrlPunctuation(url: string): string {
  return url.replace(/[),.;\]]+$/u, '');
}

function isAuthorizationUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/\.$/, '');
    // CLI login may announce its local callback listener before the actual authorization URL.
    return hostname !== 'localhost' && !hostname.endsWith('.localhost') &&
      !/^127\.\d+\.\d+\.\d+$/.test(hostname) && hostname !== '[::1]' &&
      hostname !== '0.0.0.0' && hostname !== '[::]';
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentConfigAuthErrorMessage(error: AgentConfigAuthError | AgentHostError): string {
  return 'message' in error ? error.message : error.type;
}

function noLogin(providerId: string): Result<void, AgentConfigAuthError> {
  return err({
    type: 'invalid-state',
    message: `No login PTY is active for provider '${providerId}'`,
  });
}

export function authExpiryKey(providerId: string, connectionId?: string): string {
  return connectionId && connectionId !== 'native'
    ? authKey(providerId, undefined, connectionId)
    : providerId;
}

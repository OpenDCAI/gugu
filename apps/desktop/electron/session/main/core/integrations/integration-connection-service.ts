import type { IntegrationCliTool, IntegrationCredentials, IntegrationError } from '@gugu/session-plugins/integrations';
import {
  accessTokenExpiresSoon,
  integrationPluginRegistry,
  mcpOAuthCredentialsSchema,
  toIntegrationCredentials,
} from '@gugu/session-plugins/integrations';
import { log } from '@main/lib/logger';
import type { ConnectionStatus } from '@shared/issue-providers';
import { shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cliMethodOf, publishCliLauncher, removeCliLauncher } from './cli/cli-integrations';
import { outputTail, readCliLoginStatus, startCliLogin, type CliLoginRun } from './cli/cli-login';
import { cliToolsRoot } from './cli/cli-paths';
import { startFeishuLogin, verifyFeishuLogin, setFeishuUserIdentity } from './cli/feishu-login';
import { cliInstallProgress, ensureCliTool, installedCliTool, isCliToolInstalled, isCliToolInstalling, type InstalledCliTool } from './cli/cli-tool-installer';
import { cliToolRecipe, type CliLoginPrompt, type CliToolRecipe } from './cli/cli-tools';
import {
  DEFAULT_INTEGRATION_ACCOUNT_ID,
  type IntegrationAccountRecord,
} from './integration-credential-store';
import { integrationCredentialStore } from './integration-credential-store-instance';
import {
  authorizeMcpServer,
  McpReauthorizationRequiredError,
  refreshMcpCredentials,
} from './mcp-oauth-flow';

type ConnectResult =
  | { success: true; displayName?: string; displayDetail?: string }
  | { success: false; error: string; errorType?: IntegrationError['type'] };

export type CliLoginStartResult =
  | { success: true; prompt: CliLoginPrompt }
  | { success: true; connected: true }
  | { success: false; error: string };

export type CliLoginWaitResult =
  | { status: 'pending'; prompt?: CliLoginPrompt }
  | { status: 'connected' }
  | { status: 'failed'; error: string };

/** `cliToolPrepare` 一问的回答:装好了、还在装(进度看 `cliLoginProgress`)、或装失败(原话)。 */
export type CliToolPrepareResult =
  | { status: 'ready' }
  | { status: 'installing' }
  | { status: 'failed'; error: string };

type PendingCliLogin = {
  recipe: CliToolRecipe;
  installed: InstalledCliTool;
  run: CliLoginRun;
  activityToken: symbol;
  result?: Promise<Exclude<CliLoginWaitResult, { status: 'pending' }>>;
};

/** 一次 `cliLoginWait` 最多挂这么久就回「还在等」:界面再问一次。远程机器上的调用不会被长连接拖断。 */
const CLI_LOGIN_WAIT_SLICE_MS = 20_000;
const AUTHORIZATION_ACTIVITY_LIMIT_MS = 30 * 60_000;

export type IntegrationAccountSummary = {
  accountId: string;
  displayName?: string;
  connectedAt: number;
  isDefault: boolean;
  /** 表单里不保密那几项存着的值(邮箱地址、服务器),「编辑凭据」预填用。 */
  fields: Record<string, string>;
};

export type IntegrationAccountCheck = {
  accountId: string;
  connected: boolean;
  error?: string;
  errorType?: IntegrationError['type'];
};

function formFields(integrationId: string) {
  const methods = integrationPluginRegistry.get(integrationId)?.capabilities.auth.methods ?? [];
  const form = methods.find((method) => method.kind === 'form');
  return form?.kind === 'form' ? form.fields : [];
}

function mcpOAuthServerUrl(integrationId: string): string | null {
  const methods = integrationPluginRegistry.get(integrationId)?.capabilities.auth.methods ?? [];
  const method = methods.find((candidate) => candidate.kind === 'mcp-oauth');
  return method?.kind === 'mcp-oauth' ? method.serverUrl : null;
}

export class IntegrationConnectionService {
  private readonly pendingAuthorizations = new Map<string, AbortController>();
  private readonly pendingRefreshes = new Map<string, Promise<IntegrationAccountRecord>>();
  private readonly cliLogins = new Map<string, PendingCliLogin>();
  /** 正在装 / 正在起登录的那一次连接的号(见 cliLoginStart)。 */
  private readonly cliStarts = new Map<string, symbol>();
  /** 后台装失败、还没交给界面的那一句(按工具)。 */
  private readonly cliInstallFailures = new Map<IntegrationCliTool, string>();
  /** 已经挂上结果处理的那份安装(同一份 Promise 只挂一次)。 */
  private readonly watchedCliInstalls = new WeakSet<Promise<unknown>>();
  private readonly authorizationActivityListeners = new Set<() => void>();
  private readonly authorizationActivity = new Map<AbortController | symbol, NodeJS.Timeout>();
  private authorizationActive = false;

  /** A person confirming authorization is account work even without a running
   * agent. Result entries outlive their process until a later poll, so map
   * membership alone cannot prove that authorization is still active. */
  hasPendingAuthorizations(): boolean {
    return this.authorizationActivity.size > 0;
  }

  private startAuthorizationActivity(token: AbortController | symbol): void {
    // This bounds the busy signal only. Provider login deadlines, process
    // cancellation and the eventual login result remain owned by that flow.
    const timer = setTimeout(() => this.stopAuthorizationActivity(token), AUTHORIZATION_ACTIVITY_LIMIT_MS);
    timer.unref();
    this.authorizationActivity.set(token, timer);
    this.reportAuthorizationActivity();
  }

  private stopAuthorizationActivity(token: AbortController | symbol): void {
    const timer = this.authorizationActivity.get(token);
    if (!timer) return;
    clearTimeout(timer);
    this.authorizationActivity.delete(token);
    this.reportAuthorizationActivity();
  }

  onAuthorizationActivityChange(listener: () => void): () => void {
    this.authorizationActivityListeners.add(listener);
    return () => { this.authorizationActivityListeners.delete(listener); };
  }

  private reportAuthorizationActivity(): void {
    const active = this.hasPendingAuthorizations();
    if (active === this.authorizationActive) return;
    this.authorizationActive = active;
    for (const listener of this.authorizationActivityListeners) listener();
  }

  /** Browser authorization for `mcp-oauth` integrations; resolves once the account is stored. */
  async authorize(integrationId: string): Promise<ConnectResult> {
    const acquired = await this.acquireAuthorization(integrationId);
    if (!acquired.success) return acquired;
    return this.connect(integrationId, acquired.credentials);
  }

  /**
   * The browser half of `authorize` alone: runs it on **this** machine and hands the credentials back
   * instead of storing them. #6264 — connecting an integration on another machine (a headless 咕咕 server)
   * cannot receive the loopback redirect there, so the desktop authorizes here and passes the result to
   * that machine's `connect`, which verifies and stores it as if it had authorized itself.
   */
  async acquireAuthorization(
    integrationId: string
  ): Promise<{ success: true; credentials: IntegrationCredentials } | { success: false; error: string }> {
    const plugin = integrationPluginRegistry.get(integrationId);
    if (!plugin) return { success: false, error: `Unknown integration: ${integrationId}` };
    const serverUrl = mcpOAuthServerUrl(integrationId);
    if (!serverUrl) {
      return {
        success: false,
        error: `${plugin.metadata.name} does not use browser authorization.`,
      };
    }

    // A second attempt supersedes the first instead of leaving two listeners racing.
    this.pendingAuthorizations.get(integrationId)?.abort();
    const controller = new AbortController();
    this.pendingAuthorizations.set(integrationId, controller);
    this.startAuthorizationActivity(controller);
    controller.signal.addEventListener('abort', () => this.stopAuthorizationActivity(controller), { once: true });
    try {
      const credentials = await authorizeMcpServer({
        serverUrl,
        signal: controller.signal,
        openExternal: (url) => shell.openExternal(url),
      });
      return { success: true, credentials: toIntegrationCredentials(credentials) };
    } catch (error) {
      log.warn('Integration authorization failed', { integrationId, error });
      return {
        success: false,
        error:
          error instanceof Error ? error.message : `Failed to authorize ${plugin.metadata.name}.`,
      };
    } finally {
      if (this.pendingAuthorizations.get(integrationId) === controller) {
        this.pendingAuthorizations.delete(integrationId);
      }
      this.stopAuthorizationActivity(controller);
    }
  }

  cancelAuthorization(integrationId: string): void {
    this.pendingAuthorizations.get(integrationId)?.abort();
    // 还在装 / 还在起的那一次:撤掉它的号,它醒来见号不对就自己收手(见 cliLoginStart)。
    const attempt = this.cliStarts.get(integrationId);
    this.cliStarts.delete(integrationId);
    if (attempt) this.stopAuthorizationActivity(attempt);
    const login = this.cliLogins.get(integrationId);
    if (login) {
      this.cliLogins.delete(integrationId);
      this.stopAuthorizationActivity(login.activityToken);
      login.run.cancel();
    }
  }

  /**
   * 官方命令行集成的连接,第一半:装好工具(第一次要下载),在**这台机器上**起它自带的登录,
   * 等它把要给人看的那一下(授权链接 + 授权码 / 二维码)打出来就回。登录进程留着等对方确认,
   * 结果由 `cliLoginWait` 取。远程机器上照样在那台机器上跑:登录态就落在要用它的那台机器上。
   *
   * 每一次连接领一个号:新的一次、或取消,都会作废旧号。每个 await 之后核号,号不对 = 这一次已被取代或取消,
   * 只收拾**自己**起的登录、❌ 碰表里别人的那一个(审查实撞:关了弹窗再点连接,晚到的旧一次会杀掉新登录)。
   */
  cliLoginProgress(integrationId: string) {
    const method = cliMethodOf(integrationId);
    // 进度只在真在装的时候有(装完就删):`cliToolPrepare` 起的那一次也要看得见。
    return method ? cliInstallProgress(method.tool) ?? null : null;
  }

  /**
   * 第零半:把这一家的命令行装好(第一次要下载)。一问最多挂 `CLI_LOGIN_WAIT_SLICE_MS`,界面接着问。
   * 远程机器(云电脑拉 GitHub 只有几十 KB/s)装一次要十来分钟:❌ 把它绑在 `cliLoginStart` 一次远程调用上 ——
   * 链路一断,在途调用全判失败,界面只能说「连不上」,重点一次又从头等。装在后台跑(同一工具只装一份),
   * 断了重连接着问;装好了 `cliLoginStart` 当场就能起登录。
   */
  async cliToolPrepare(integrationId: string): Promise<CliToolPrepareResult> {
    const plugin = integrationPluginRegistry.get(integrationId);
    const method = cliMethodOf(integrationId);
    if (!plugin || !method) {
      return { status: 'failed', error: `${plugin?.metadata.name ?? integrationId} does not connect through a command-line tool.` };
    }
    if (isCliToolInstalled(method.tool)) return { status: 'ready' };
    // 上一次在后台装失败了、还没人来取:先把失败交出去(❌ 悄悄再装一遍,让界面永远停在「还在装」)。
    const failed = this.cliInstallFailures.get(method.tool);
    if (failed !== undefined && !isCliToolInstalling(method.tool)) {
      this.cliInstallFailures.delete(method.tool);
      return { status: 'failed', error: failed };
    }
    const pending = ensureCliTool(method.tool);
    // 装的那十来分钟里每 20 秒会来问一次:结果只记一回(❌ 失败时同一条日志打几十遍)。
    if (!this.watchedCliInstalls.has(pending)) {
      this.watchedCliInstalls.add(pending);
      pending.then(
        () => this.cliInstallFailures.delete(method.tool),
        (error: unknown) => {
          log.warn('Integration command-line tool could not be installed', { integrationId, error });
          this.cliInstallFailures.set(method.tool, error instanceof Error ? error.message : String(error));
        }
      );
    }
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      pending.then(() => 'ready' as const, () => 'failed' as const),
      new Promise<'installing'>((resolve) => (timer = setTimeout(() => resolve('installing'), CLI_LOGIN_WAIT_SLICE_MS))),
    ]).finally(() => clearTimeout(timer));
    if (outcome !== 'failed') return { status: outcome };
    const error = this.cliInstallFailures.get(method.tool) ?? 'The command-line tool could not be installed.';
    this.cliInstallFailures.delete(method.tool);
    return { status: 'failed', error };
  }

  async cliLoginStart(integrationId: string): Promise<CliLoginStartResult> {
    const plugin = integrationPluginRegistry.get(integrationId);
    const method = cliMethodOf(integrationId);
    if (!plugin || !method) {
      return { success: false, error: `${plugin?.metadata.name ?? integrationId} does not connect through a command-line tool.` };
    }
    this.cancelAuthorization(integrationId);
    const attempt = Symbol(integrationId);
    this.cliStarts.set(integrationId, attempt);
    this.startAuthorizationActivity(attempt);
    const current = () => this.cliStarts.get(integrationId) === attempt;
    const superseded = { success: false as const, error: 'This connection attempt was cancelled.' };
    const recipe = cliToolRecipe(method.tool);
    let entry: PendingCliLogin | undefined;
    try {
      const installed = await ensureCliTool(method.tool);
      if (!current()) return superseded;
      // 上一次已经完成个人授权、但尚未写入咕咕记录时，重试复用经服务端验证的用户登录。
      if (method.tool === 'lark-cli' && await fs.stat(path.join(installed.homeDir, 'config', 'config.json')).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      }) && await readCliLoginStatus(recipe, installed) && await verifyFeishuLogin(installed)) {
        if (!current()) return superseded;
        // 只改咕咕专属配置；后续默认以用户身份操作。
        await setFeishuUserIdentity(installed);
        if (!current()) return superseded;
        const connected = await this.connect(integrationId, { tool: recipe.tool, connectedAt: Date.now() });
        if (!connected.success) return connected;
        try {
          await publishCliLauncher(recipe, installed);
        } catch (error) {
          await integrationCredentialStore.delete(integrationId);
          throw error;
        }
        return { success: true, connected: true };
      }
      // 每一次登录一个自己的工作目录(企业微信的二维码就写在这里),结束就删。
      await fs.mkdir(path.join(cliToolsRoot(), method.tool), { recursive: true });
      const work = await fs.mkdtemp(path.join(cliToolsRoot(), method.tool, 'login-'));
      await fs.mkdir(installed.homeDir, { recursive: true });
      if (!current()) {
        await fs.rm(work, { recursive: true, force: true });
        return superseded;
      }
      const run = method.tool === 'lark-cli' ? startFeishuLogin(installed, work) : startCliLogin(recipe, installed, work);
      void run.done.then(() => fs.rm(work, { recursive: true, force: true }));
      void run.done.then(() => this.stopAuthorizationActivity(attempt));
      entry = { recipe, installed, run, activityToken: attempt };
      this.cliLogins.set(integrationId, entry);
      const prompt = await run.prompt;
      if (!current() || this.cliLogins.get(integrationId) !== entry) {
        run.cancel();
        return superseded;
      }
      return { success: true, prompt };
    } catch (error) {
      log.warn('Integration command-line login could not start', { integrationId, error });
      if (entry) {
        this.stopAuthorizationActivity(attempt);
        entry.run.cancel();
        if (this.cliLogins.get(integrationId) === entry) this.cliLogins.delete(integrationId);
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (this.cliStarts.get(integrationId) === attempt) this.cliStarts.delete(integrationId);
      if (!entry) this.stopAuthorizationActivity(attempt);
    }
  }

  /** 第二半:登录进程结束了没有;结束了就问工具「登上了吗」,登上了才记成已连接、把命令放上 agent 的 PATH。 */
  async cliLoginWait(integrationId: string): Promise<CliLoginWaitResult> {
    const pending = this.cliLogins.get(integrationId);
    if (!pending) return { status: 'failed', error: 'No login is in progress. Start again.' };
    pending.result ??= this.finishCliLogin(integrationId, pending);
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      pending.result,
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), CLI_LOGIN_WAIT_SLICE_MS))),
    ]).finally(() => clearTimeout(timer));
    if (!result) return { status: 'pending', ...(pending.run.currentPrompt ? { prompt: pending.run.currentPrompt } : {}) };
    if (this.cliLogins.get(integrationId) === pending) this.cliLogins.delete(integrationId);
    return result;
  }

  private async finishCliLogin(
    integrationId: string,
    pending: PendingCliLogin
  ): Promise<Exclude<CliLoginWaitResult, { status: 'pending' }>> {
    const { recipe, installed, run } = pending;
    const outcome = await run.done;
    if (outcome.kind === 'cancelled') return { status: 'failed', error: 'Login was cancelled.' };
    if (outcome.kind === 'timed-out') {
      return { status: 'failed', error: 'The login expired before it was confirmed. Start again.' };
    }
    if (outcome.code !== 0) {
      return { status: 'failed', error: outputTail(outcome.output) || `${recipe.bin} login exited with ${outcome.code}.` };
    }
    try {
      if (!(await readCliLoginStatus(recipe, installed))) {
        return { status: 'failed', error: `${recipe.bin} finished, but says it is not logged in.` };
      }
      if (recipe.tool === 'lark-cli' && !(await verifyFeishuLogin(installed))) {
        return { status: 'failed', error: 'Feishu could not verify your personal account. Connect again.' };
      }
      // 网络验证期间也可能取消或重试，旧的一次不能再记成已连接。
      if (this.cliLogins.get(integrationId) !== pending) return { status: 'failed', error: 'Login was cancelled.' };
      // 先记连接、再放命令:「agent 的 PATH 上有它」必须意味着「记着连着」。放命令失败就撤回记录。
      const connected = await this.connect(integrationId, { tool: recipe.tool, connectedAt: Date.now() });
      if (!connected.success) return { status: 'failed', error: connected.error };
      try {
        await publishCliLauncher(recipe, installed);
      } catch (error) {
        await integrationCredentialStore.delete(integrationId);
        throw error;
      }
      return { status: 'connected' };
    } catch (error) {
      log.warn('Integration command-line login could not finish', { integrationId, error });
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The stored account, with an `mcp-oauth` access token renewed first when it
   * is about to expire. Concurrent callers share one refresh: providers may
   * rotate refresh tokens, and a second request with the spent one would read
   * as a revoked authorization.
   */
  async getFreshAccount(
    integrationId: string,
    accountId?: string
  ): Promise<IntegrationAccountRecord | null> {
    const account = await integrationCredentialStore.getAccount(integrationId, accountId);
    if (!account || !mcpOAuthServerUrl(integrationId)) return account;
    const parsed = mcpOAuthCredentialsSchema.safeParse(account.credentials);
    // An unparseable record is reported by the plugin, which owns the reconnect wording.
    if (!parsed.success || !accessTokenExpiresSoon(parsed.data)) return account;

    const key = `${integrationId}:${account.accountId}`;
    const inFlight = this.pendingRefreshes.get(key);
    if (inFlight) return inFlight;

    const refresh = (async () => {
      const refreshed = await refreshMcpCredentials(parsed.data);
      const next = { ...account, credentials: toIntegrationCredentials(refreshed) };
      await integrationCredentialStore.upsertAccount(integrationId, next);
      return next;
    })().finally(() => this.pendingRefreshes.delete(key));
    this.pendingRefreshes.set(key, refresh);
    return refresh;
  }

  async connect(
    integrationId: string,
    input: IntegrationCredentials,
    /** #7240「编辑凭据」:改的是哪个已存账号。表单里留空的保密项(授权码)沿用它存着的那一份。 */
    editAccountId?: string
  ): Promise<ConnectResult> {
    const plugin = integrationPluginRegistry.get(integrationId);
    if (!plugin) return { success: false, error: `Unknown integration: ${integrationId}` };
    let credentials = input;
    if (editAccountId) {
      try {
        credentials = await this.withSavedSecrets(integrationId, input, editAccountId);
      } catch (error) {
        return { success: false, error: (error as Error).message, errorType: 'invalid_input' };
      }
    }

    const result = await plugin.behavior.auth?.verify({ log }, credentials);
    if (!result?.connected) {
      return {
        success: false,
        error: result?.error?.message ?? `Failed to connect ${plugin.metadata.name}.`,
        ...(result?.error ? { errorType: result.error.type } : {}),
      };
    }

    const accountId = result.account
      ? `${result.account.host ?? integrationId}:${result.account.id}`
      : DEFAULT_INTEGRATION_ACCOUNT_ID;
    await integrationCredentialStore.upsertAccount(integrationId, {
      accountId,
      ...(result.displayName ? { displayName: result.displayName } : {}),
      credentials: result.credentials ?? credentials,
    });
    // 编辑时改了服务器:新的那份已存好,旧的那份是同一个邮箱的过时记录,删掉 ——
    // ❌ 留着两条同一地址的账号(agent 点名用它时会挑到旧的那条)。
    if (editAccountId && editAccountId !== accountId) {
      await integrationCredentialStore.delete(integrationId, editAccountId);
    }

    return {
      success: true,
      displayName: result.displayName,
      displayDetail: result.displayDetail,
    };
  }

  /** 表单里留空的保密项 → 那个账号存着的同名一项(提示「%s已保存,留空则保留」)。 */
  private async withSavedSecrets(
    integrationId: string,
    input: IntegrationCredentials,
    accountId: string
  ): Promise<IntegrationCredentials> {
    const saved = await integrationCredentialStore.getAccount(integrationId, accountId);
    if (!saved) throw new Error(`${integrationId} account ${accountId} is not saved any more; connect it again.`);
    const filled: IntegrationCredentials = { ...input };
    const fields = formFields(integrationId);
    // 存着的授权码只交还给**原来那台服务器、原来那个地址**:改了服务器 / 地址又留空授权码,❌ 把它递给新服务器。
    const changed = fields.filter(
      (field) => !field.secret && typeof saved.credentials[field.id] === 'string' && input[field.id] !== saved.credentials[field.id]
    );
    const blankSecret = fields.some((field) => field.secret && (typeof input[field.id] !== 'string' || !String(input[field.id]).trim()));
    if (changed.length > 0 && blankSecret) {
      throw new Error(`${changed.map((field) => field.id).join(', ')} changed: enter the authorization code again.`);
    }
    for (const field of fields) {
      const given = input[field.id];
      const kept = saved.credentials[field.id];
      if (field.secret && (typeof given !== 'string' || !given.trim()) && typeof kept === 'string') filled[field.id] = kept;
    }
    return filled;
  }

  /**
   * #7240 这一家存着的每个账号(多账号:邮箱一个地址一个),连同连上的时间,和表单里**不保密**那几项存着的值
   * (「编辑凭据」预填用;授权码这类保密项 ❌ 回给界面)。
   */
  async listAccounts(integrationId: string): Promise<IntegrationAccountSummary[]> {
    const fields = formFields(integrationId).filter((field) => !field.secret);
    return (await integrationCredentialStore.listAccounts(integrationId)).map((account) => ({
      accountId: account.accountId,
      ...(account.displayName ? { displayName: account.displayName } : {}),
      connectedAt: account.connectedAt,
      isDefault: account.isDefault,
      fields: Object.fromEntries(
        fields.flatMap((field) => {
          const value = account.credentials[field.id];
          return typeof value === 'string' ? [[field.id, value]] : [];
        })
      ),
    }));
  }

  /** #7240 每个账号各查一次还连不连得上(详情里逐个账号的状态)。 */
  async checkAccounts(integrationId: string): Promise<IntegrationAccountCheck[]> {
    const plugin = integrationPluginRegistry.get(integrationId);
    if (!plugin) throw new Error(`Unknown integration: ${integrationId}`);
    const accounts = await integrationCredentialStore.listAccounts(integrationId);
    return Promise.all(
      accounts.map(async (account): Promise<IntegrationAccountCheck> => {
        try {
          const result = await plugin.behavior.auth?.verify({ log }, account.credentials);
          if (result?.connected) return { accountId: account.accountId, connected: true };
          return {
            accountId: account.accountId,
            connected: false,
            ...(result?.error ? { error: result.error.message, errorType: result.error.type } : {}),
          };
        } catch (error) {
          return { accountId: account.accountId, connected: false, error: (error as Error).message };
        }
      })
    );
  }

  async disconnect(integrationId: string, accountId?: string): Promise<{ success: boolean; error?: string }> {
    if (accountId) {
      // #7240 多账号里断开一个:只删这一个(提示「只会断开 %s」)。
      try {
        await integrationCredentialStore.delete(integrationId, accountId);
        return { success: true };
      } catch (error) {
        log.error('Failed to disconnect integration account', { integrationId, accountId, error });
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const method = cliMethodOf(integrationId);
    if (method) {
      // 断开 = 先把命令从 agent 的 PATH 上拿掉、删掉工具在咕咕里的登录态(装好的程序留着,重连不用再下),
      // 再删记录:哪一步失败,卡片都还在「已连接」、还能再点断开,并说出真实原因。
      try {
        this.cancelAuthorization(integrationId);
        await removeCliLauncher(cliToolRecipe(method.tool));
        await fs.rm(installedCliTool(method.tool).homeDir, { recursive: true, force: true });
      } catch (error) {
        log.error('Failed to remove a command-line integration from this machine', { integrationId, error });
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      await integrationCredentialStore.delete(integrationId);
      return { success: true };
    } catch (error) {
      log.error('Failed to disconnect integration', { integrationId, error });
      return { success: false, error: 'Unable to remove credentials from secure storage.' };
    }
  }

  async checkConnection(
    integrationId: string,
    capabilities: ConnectionStatus['capabilities'],
    accountId?: string
  ): Promise<ConnectionStatus> {
    const plugin = integrationPluginRegistry.get(integrationId);
    if (!plugin) {
      return {
        connected: false,
        error: `Unknown integration: ${integrationId}`,
        capabilities,
      };
    }

    let account: IntegrationAccountRecord | null;
    try {
      account = await this.getFreshAccount(integrationId, accountId);
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Connection check failed.',
        // 续不上(被拒,或这家根本不发续期令牌,如滴答清单):界面说「授权已失效,请重新连接」,
        // ❌ 落成一句英文原话,也 ❌ 当成还连着。
        ...(error instanceof McpReauthorizationRequiredError
          ? { errorType: 'authorization_expired' as const }
          : {}),
        capabilities,
      };
    }
    if (!account) return { connected: false, capabilities };

    try {
      const result = await plugin.behavior.auth?.verify({ log }, account.credentials);
      if (!result?.connected) {
        return {
          connected: false,
          error: result?.error?.message,
          ...(result?.error ? { errorType: result.error.type } : {}),
          capabilities,
        };
      }
      const cli = cliMethodOf(integrationId);
      if (cli) {
        // 记录说连着不算数,要工具自己说还登着(对方那边撤了授权、登录过期,都只有它知道)。
        const recipe = cliToolRecipe(cli.tool);
        const loggedIn =
          isCliToolInstalled(cli.tool) && (await readCliLoginStatus(recipe, installedCliTool(cli.tool)));
        if (!loggedIn) {
          return {
            connected: false,
            error: `${recipe.bin} is not logged in any more.`,
            errorType: 'authorization_expired',
            capabilities,
          };
        }
      }
      if (result.credentials) {
        await integrationCredentialStore.upsertAccount(integrationId, {
          ...account,
          credentials: result.credentials,
        });
      }
      return {
        connected: true,
        displayName: result.displayName,
        displayDetail: result.displayDetail,
        capabilities,
      };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Connection check failed.',
        capabilities,
      };
    }
  }
}

export const integrationConnectionService = new IntegrationConnectionService();

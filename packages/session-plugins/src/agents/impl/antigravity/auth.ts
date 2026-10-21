import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';
import { ANTIGRAVITY_LAUNCH_SCRIPT } from './session-bundle';

/**
 * Antigravity(官方 ACP 服务 `agy_acp_server`)的登录 —— **协议登录**,没有登录子命令(#6335)。
 *
 * 咕咕替它发 ACP `authenticate {methodId:'oauth-personal'}`(`initialize.authMethods` 自报的 id,逐字):
 * 它在 stderr 打出「Open the following link to authenticate the ACP server: https://accounts.google.com/…」,
 * 自己拉起系统浏览器,阻塞到本地回调 `127.0.0.1:<port>` 收到授权码(2026-09-23 实测)。
 * 名字与它自报的逐字一致:「Log in with Google」。
 */
export const ANTIGRAVITY_GOOGLE_LOGIN_METHOD_ID = 'google';
export const ANTIGRAVITY_OAUTH_PERSONAL = 'oauth-personal';

/** 配置根 —— `$GEMINI_HOME`(实测日志「Gemini home resolved to … (from $GEMINI_HOME)」),默认 `~/.gemini`。 */
export const ANTIGRAVITY_HOME_ENV = 'GEMINI_HOME';
/** home 相对:`~/.gemini/antigravity-acp/…`。与 agy CLI 的 `~/.gemini/antigravity-cli/` 不是同一处。 */
const ACP_DIR = '.gemini/antigravity-acp';
export const ANTIGRAVITY_ACP_SETTINGS_PATH = `${ACP_DIR}/settings.json`;
const TOKEN_FILE: Record<'oauth-personal' | 'oauth-business', string> = {
  'oauth-personal': `${ACP_DIR}/acp_token.json`,
  'oauth-business': `${ACP_DIR}/acp_business_token.json`,
};

/**
 * `settings.json` 的 `auth.type` 取值域 —— 未登录时 `session/new` 的 `-32000` 那句原文逐个点名:
 * 「set `auth.type` in settings.json … to one of: oauth-personal, gemini-api-key, oauth-business …,
 *  agent-platform」。`authenticate` 成功就把它写进去(实测 authenticate(gemini-api-key) 后出现
 * `{"auth":{"type":"gemini-api-key"}}`)。
 */
const AUTH_TYPES = new Set(['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform']);

/**
 * OAuth 凭据在 macOS 上进钥匙串:service `gemini`、account `antigravity-acp`
 * (厂商 credential_store.py 的 `KEYCHAIN_SERVICE="gemini"`,acp 服务的 `_KEYCHAIN_ACCOUNT="antigravity-acp"`;
 * agy CLI 自己那一项是 account `antigravity`,**故意不同** —— 这正是「登录不与 CLI 共用」的由来)。
 *
 * ⚠️ `find-generic-password` **不带 `-w`**:带 `-w` 要读密码本体,会弹「允许访问钥匙串」的系统框;
 *    不带只问「这一项在不在」,立即返回、不弹框(2026-09-23 实测:在 = 退出码 0,不在 = 44)。
 * ⚠️ `AGY_ACP_FORCE_FILE_STORAGE=1` 时它不用钥匙串、落 token 文件 —— 那时照文件判。
 */
const SECURITY = '/usr/bin/security';
const KEYCHAIN_ARGS = ['find-generic-password', '-s', 'gemini', '-a', 'antigravity-acp'];
const KEYCHAIN_ITEM_NOT_FOUND = 44;
export const FORCE_FILE_STORAGE_ENV = 'AGY_ACP_FORCE_FILE_STORAGE';

export async function antigravityAuthStatus(
  ctx: AgentAuthContext,
  platform: NodeJS.Platform = process.platform
): Promise<AgentAuthStatus> {
  // 与 kimi 同一条:数据根被**用户自己**挪走、而手上这把 fs 锚在真 home 上时,读到的不是它会读的那份。
  const relocated = ctx.env?.[ANTIGRAVITY_HOME_ENV]?.trim();
  if (relocated && !ctx.fsFollowsConfigRoot) {
    return {
      kind: 'unknown',
      message: `${ANTIGRAVITY_HOME_ENV} 指向 ${relocated},咕咕这条 home 相对的读法照不到那份 settings.json。`,
    };
  }

  let content: string | null;
  try {
    content = await ctx.fs.read(ANTIGRAVITY_ACP_SETTINGS_PATH);
  } catch (error) {
    return { kind: 'unknown', message: `无法读取 ${ANTIGRAVITY_ACP_SETTINGS_PATH}:${messageOf(error)}` };
  }
  // 没有这份文件 = 它从没被登录过(authenticate 成功必写 auth.type)。
  if (content === null) {
    return { kind: 'unauthenticated', message: '还没有登录过 Antigravity(这台机器上没有它的登录方式记录)。' };
  }
  let authType: unknown;
  try {
    authType = (JSON.parse(content) as { auth?: { type?: unknown } } | null)?.auth?.type;
  } catch (error) {
    return { kind: 'unknown', message: `${ANTIGRAVITY_ACP_SETTINGS_PATH} 解析失败:${messageOf(error)}` };
  }
  if (typeof authType !== 'string' || !AUTH_TYPES.has(authType)) {
    return { kind: 'unauthenticated', message: '还没有选定登录方式。' };
  }

  switch (authType) {
    case 'gemini-api-key':
      // 这条的凭据就是进程环境里的 GEMINI_API_KEY(auth.type 只是选中它)。
      return ctx.env?.GEMINI_API_KEY?.trim()
        ? { kind: 'authenticated' }
        : {
            kind: 'unknown',
            message: '登录方式是 Gemini API key,但咕咕交给它的环境里没有 GEMINI_API_KEY。',
          };
    case 'agent-platform':
      // ADC / GOOGLE_API_KEY / 项目与区域 —— 凭据散在 gcloud 那一侧,咕咕判不了。
      return { kind: 'unknown', message: '登录方式是 Agent Platform(原 Vertex AI),凭据在 gcloud 一侧,咕咕判不了。' };
    default:
      return oauthCredentialStatus(ctx, authType as 'oauth-personal' | 'oauth-business', platform);
  }
}

async function oauthCredentialStatus(
  ctx: AgentAuthContext,
  authType: 'oauth-personal' | 'oauth-business',
  platform: NodeJS.Platform
): Promise<AgentAuthStatus> {
  const forceFile = ctx.env?.[FORCE_FILE_STORAGE_ENV]?.trim() === '1';
  if (platform === 'darwin' && !forceFile) {
    // ⚠️ UNVERIFIED:oauth-business 在钥匙串里是否也是这个 account 没实测(只量过 oauth-personal 的读法)。
    try {
      await ctx.exec(SECURITY, KEYCHAIN_ARGS, { timeout: 5_000 });
      return { kind: 'authenticated' };
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === KEYCHAIN_ITEM_NOT_FOUND) {
        return { kind: 'unauthenticated', message: '钥匙串里没有 Antigravity 的登录凭据(可能已过期被清掉)。' };
      }
      return { kind: 'unknown', message: `读钥匙串失败:${messageOf(error)}` };
    }
  }
  try {
    const token = await ctx.fs.read(TOKEN_FILE[authType]);
    return token === null
      ? { kind: 'unauthenticated', message: `没有 ${TOKEN_FILE[authType]} —— 登录凭据不在。` }
      : { kind: 'authenticated' };
  } catch (error) {
    return { kind: 'unknown', message: `无法读取 ${TOKEN_FILE[authType]}:${messageOf(error)}` };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 终端腿的程序 `agy`(伴随程序 `antigravity-cli`)自己的登录(#6335)—— 与上面 ACP 服务那份**不共享**:
 * 钥匙串里是两条条目(account `antigravity` vs `antigravity-acp`),登了一个另一个照样没登。
 *
 * 登录入口:`agy` 没有任何登录子命令(`agy --help` 全表:agent/changelog/help/install/mcp/mic-serve/
 * models/plugin/remote-control/update),登录长在它自己的 TUI 首屏上 —— 钥匙串里没有凭据时,它起来就是
 * 「You are currently not signed in … Select login method: 1. Google OAuth 2. Use a Google Cloud project」
 * (d22 Linux 实测,agy 1.2.10),选 OAuth 后桌面上自己开浏览器(https://antigravity.google/docs/cli/install
 * 「Local silent keyring sign-in」),SSH 下打印链接、要求贴回授权码(同页「Remote SSH OAuth flow」)。
 * ⇒ 咕咕的登录终端就是**起一个 `agy`**,由它自己的 TUI 带用户登完;咕咕只管入口与状态。
 * 它跟终端腿走**同一个启动器**(`ANTIGRAVITY_LAUNCH_SCRIPT`,只换 `agy` 这一个进程的 HOME)、同一份
 * 可执行文件(宿主按 `tui` 解析),所以登录落进的就是终端会话会读的那个托管根与那份钥匙串。
 */
export const ANTIGRAVITY_CLI_PROGRAM = 'antigravity-cli';
export const ANTIGRAVITY_CLI_LOGIN_METHOD_ID = 'google';

/**
 * `agy` 自己的设置文件(托管根里,两条腿共用的 `.gemini` 下)。API key 模式的开关在这里:
 * `{"modelProvider":"gemini"}` + 环境里的 `GEMINI_API_KEY`(docs/cli/install「Using a Gemini API key」:
 * 「Only setting a `GEMINI_API_KEY` environment variable on its own has no effect」)。
 */
export const ANTIGRAVITY_CLI_SETTINGS_PATH = '.gemini/antigravity-cli/settings.json';

export async function antigravityCliAuthStatus(
  ctx: AgentAuthContext,
  platform: NodeJS.Platform = process.platform
): Promise<AgentAuthStatus> {
  // 与 ACP 那份同一条:手上这把 fs 与 `agy` 会读的那份托管根不是同一处时,API key 模式判不了。
  const relocated = ctx.env?.[ANTIGRAVITY_HOME_ENV]?.trim();
  if (relocated && !ctx.fsFollowsConfigRoot) {
    return {
      kind: 'unknown',
      message: `${ANTIGRAVITY_HOME_ENV} 指向 ${relocated},咕咕这条 home 相对的读法照不到 agy 的 settings.json。`,
    };
  }

  // 先看它是不是 API key 模式 —— 那时它根本不走账号(「the CLI never establishes an account session」)。
  let content: string | null;
  try {
    content = await ctx.fs.read(ANTIGRAVITY_CLI_SETTINGS_PATH);
  } catch (error) {
    return { kind: 'unknown', message: `无法读取 ${ANTIGRAVITY_CLI_SETTINGS_PATH}:${messageOf(error)}` };
  }
  if (content !== null) {
    let provider: unknown;
    try {
      provider = (JSON.parse(content) as { modelProvider?: unknown } | null)?.modelProvider;
    } catch (error) {
      return { kind: 'unknown', message: `${ANTIGRAVITY_CLI_SETTINGS_PATH} 解析失败:${messageOf(error)}` };
    }
    // 「`gemini` is the only accepted value」(同页 Troubleshooting 表);别的值它当没设、照常走账号。
    if (provider === 'gemini') {
      return ctx.env?.GEMINI_API_KEY?.trim()
        ? { kind: 'authenticated' }
        : {
            kind: 'unknown',
            message: 'agy 设成了 Gemini API key 模式,但咕咕交给它的环境里没有 GEMINI_API_KEY(它会起不来)。',
          };
    }
  }

  // ⚠️ Windows 上没有终端腿(`ANTIGRAVITY_SESSION_TUI_ENABLED`),这一格没有调用方会去用。
  if (platform === 'win32') {
    return { kind: 'unknown', message: 'Windows 上没有 agy 终端腿。' };
  }
  return agyModelsAuthStatus(ctx);
}

/**
 * 问 `agy` 自己登没登(#6335):`agy models` 没登录时退出码 1、stderr
 * 「Error: Please sign in to view available models. Launch the CLI without arguments to sign in.」,
 * 登录了列出模型、退出码 0(agy 1.2.14 实测:Linux 未登录 2.2s;mac1 已登录 4s)。
 * ❌ 咕咕自己去读凭据:同一个 agy 1.2.14 在 mac 上能写钥匙串(service `gemini` / account `antigravity`,
 * 09-24 实测),钥匙串锁着时(经 SSH 登录)就写进 `.gemini/antigravity-cli/antigravity-oauth-token`
 * (10-02 mac1 实测,钥匙串那一项 44);Linux 上是 Secret Service(二进制带 zalando/go-keyring)。
 * 落点由它定、会变,判据交给写凭据的那个程序。
 * 与终端腿同一个启动器(只换 `agy` 这一个进程的 HOME,mac 上顺带接好钥匙串的软链):`agy models` 会在
 * HOME 下建 `.gemini/antigravity-cli/`,用真 HOME 跑就是往用户自己的家里写。启动器靠 `GEMINI_HOME`
 * 找影子 home,宿主的 exec 不带 `ctx.env`,所以经 `env` 交给它。
 * 超时 15 秒:它要联网拉模型列表(不是只读本地),2026-10-13 本机经启动器实测 3.2–4.0 秒、偶尔过 5 秒 ——
 * 原先照 claude `auth status`(纯本地)定的 5 秒会把「登着」偶发读成「判不出」。
 */
const AGY_MODELS_TIMEOUT_MS = 15_000;
const AGY_SIGNED_OUT = /please sign in/i;

async function agyModelsAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  const geminiHome = ctx.env?.[ANTIGRAVITY_HOME_ENV]?.trim();
  if (!geminiHome) return { kind: 'unknown', message: `宿主没给 ${ANTIGRAVITY_HOME_ENV},找不到 agy 的托管根。` };
  try {
    await ctx.exec(
      '/usr/bin/env',
      [`${ANTIGRAVITY_HOME_ENV}=${geminiHome}`, '/bin/sh', '-c', ANTIGRAVITY_LAUNCH_SCRIPT, ctx.cli, 'models'],
      { timeout: AGY_MODELS_TIMEOUT_MS }
    );
    return { kind: 'authenticated' };
  } catch (error) {
    const { code, stderr, stdout, killed } = (error ?? {}) as {
      code?: unknown;
      stderr?: unknown;
      stdout?: unknown;
      killed?: unknown;
    };
    if (code === 1 && AGY_SIGNED_OUT.test(`${String(stderr ?? '')}\n${String(stdout ?? '')}`)) {
      return { kind: 'unauthenticated', message: 'agy 报告还没登录。' };
    }
    // 这句会原样摆到设置里给人看:execFile 的 message 开头是整条命令(连启动器脚本),❌ 拿它当原因。
    if (killed === true) {
      return { kind: 'unknown', message: `agy models ${AGY_MODELS_TIMEOUT_MS / 1000} 秒没答完(它要联网拉模型列表)。` };
    }
    const said = lastLine(stderr) ?? lastLine(stdout);
    return said !== undefined && typeof code === 'number'
      ? { kind: 'unknown', message: `agy models 失败(退出码 ${code}):${said}` }
      : { kind: 'unknown', message: `agy models 失败:${messageOf(error)}` };
  }
}

function lastLine(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  return output.trim().split('\n').at(-1)?.trim() || undefined;
}

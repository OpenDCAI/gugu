import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';

/**
 * CodeBuddy Code 的登录 —— **协议登录**(与 antigravity 同一种):CLI 没有登录子命令
 * (`codebuddy --help` 2.169.0 的子命令表里没有 login),TUI 里是 `/login`;未登录时 ACP
 * `session/new` 回 `-32000 Authentication required`(实测 A),`initialize.authMethods` 自报
 * `iOA` / `external` / `internal` / `selfhosted`。咕咕替它发 `authenticate {methodId}`,
 * 它自己拉起浏览器完成登录(`dist/codebuddy.js` 的 `authenticate()`:`authManager.login({type})`)。
 *
 * 只摆两种个人账号入口:国际版(`external`,Google / GitHub,www.codebuddy.ai)与中国版
 * (`internal`,微信,copilot.tencent.com)。iOA(腾讯内网)与私有化(selfhosted)是企业入口,
 * 由用户在 CodeBuddy 自己的配置里选定,咕咕照原样带进去,❌ 不为它们造入口。
 */
export const CODEBUDDY_INTERNATIONAL_LOGIN_METHOD_ID = 'codebuddy-international';
export const CODEBUDDY_CHINA_LOGIN_METHOD_ID = 'codebuddy-china';
export const CODEBUDDY_ACP_INTERNATIONAL = 'external';
export const CODEBUDDY_ACP_CHINA = 'internal';

/** 官方文档 https://www.codebuddy.ai/docs/cli/iam:两种凭据都是环境变量。 */
const CODEBUDDY_CREDENTIAL_ENVS = ['CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY'] as const;

/**
 * 浏览器登录落盘的那份会话 —— CLI 的 `FileAuthenticationStorage`(发行包 2.179.3 `dist/codebuddy.js`):
 * `getAuthSavePath()` = `<数据根>/Data/Public/auth/<authentication.id>.info`,数据根按平台
 * (`FilePathServiceImpl.getBasePath`,同包里 `resolveEnvFromSessionFileSync` 读同一份文件时也是这一套):
 *  · darwin `~/Library/Application Support/CodeBuddyExtension`
 *  · win32  `~/AppData/Local/CodeBuddyExtension`(`os.homedir()` 起算,❌ 不看 `%LOCALAPPDATA%`)
 *  · 其余   `~/.local/share/CodeBuddyExtension`
 * `authentication.id` 是包里 `product.json` 的 `Tencent-Cloud.coding-copilot`;国际版与中国版写的是同一份,
 * 区别只在文件里的 `auth.domain`。`CODEBUDDY_CONFIG_DIR` 挪的是 `~/.codebuddy`,❌ 挪不动这里。
 * 登出时它不删文件,而是旁边落一个 `<文件>.logged-out` 标记(`getLogoutMarkerPath`);读的时候先看标记。
 * 令牌字段可能被它加密(`AUTH_CREDENTIAL_FIELDS`),所以只认「`auth` 与 `account` 都在」—— 它自己
 * 恢复会话时的判据也是这一条(`readAndApplyFinalState`:缺一个就是 invalid session payload)。
 */
const CODEBUDDY_AUTH_ID = 'Tencent-Cloud.coding-copilot';

export function codebuddyAuthDir(platform: NodeJS.Platform): string {
  const base =
    platform === 'darwin'
      ? 'Library/Application Support/CodeBuddyExtension'
      : platform === 'win32'
        ? 'AppData/Local/CodeBuddyExtension'
        : '.local/share/CodeBuddyExtension';
  return `${base}/Data/Public/auth`;
}

/**
 * 「登没登 CodeBuddy 账号」。
 *
 * · 环境里有 `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_API_KEY` → `authenticated`(IAM 文档的三种凭据里
 *   这两种由环境直接给出,有它就一定走得通)。
 * · 否则读浏览器登录落盘的那份会话(见 `codebuddyAuthDir`):有登出标记或没有会话文件 → `unauthenticated`;
 *   会话里 `auth`、`account` 都在 → `authenticated`。读不出 / 解析不出 → `unknown`(失败仪器不是阴性读数)。
 * · 会话文件不在、但目录里有别的 `.info`(定制品牌 / 私有化部署的 `authentication.id` 不是默认那个,
 *   `resolveCustomAuthId`)→ `unknown`,❌ 说成没登录。
 */
export async function codebuddyAuthStatus(
  ctx: AgentAuthContext,
  platform: NodeJS.Platform = process.platform
): Promise<AgentAuthStatus> {
  if (CODEBUDDY_CREDENTIAL_ENVS.some((name) => ctx.env?.[name]?.trim())) {
    return { kind: 'authenticated', credentialKind: 'api-key' };
  }
  const dir = codebuddyAuthDir(platform);
  const sessionPath = `${dir}/${CODEBUDDY_AUTH_ID}.info`;
  try {
    if (await ctx.fs.exists(`${sessionPath}.logged-out`)) {
      return { kind: 'unauthenticated', message: '已经退出了 CodeBuddy 登录。' };
    }
    const content = await ctx.fs.read(sessionPath);
    if (content === null) {
      const others = (await ctx.fs.list(dir)).filter(
        (name) => name.endsWith('.info') && !name.startsWith(`${CODEBUDDY_AUTH_ID}.`)
      );
      return others.length > 0
        ? { kind: 'unknown', message: `CodeBuddy 的登录记录不是默认产品的(${others.join(', ')}),咕咕判不了。` }
        : { kind: 'unauthenticated', message: '还没有登录过 CodeBuddy。' };
    }
    const session = JSON.parse(content) as { auth?: unknown; account?: unknown } | null;
    return isObject(session?.auth) && isObject(session?.account)
      ? { kind: 'authenticated' }
      : { kind: 'unauthenticated', message: 'CodeBuddy 的登录记录里没有有效会话。' };
  } catch (error) {
    return { kind: 'unknown', message: `无法读取 CodeBuddy 的登录记录 ${sessionPath}:${messageOf(error)}` };
  }
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

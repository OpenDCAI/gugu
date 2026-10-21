import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';

/**
 * Qoder CLI 的登录方式 —— **一手出处**(CLI 本体闭源,取证走「发行包 + 官方文档」两路对齐):
 *
 *  · 子命令本体:发行包 `@qoder-ai/qodercli@1.1.31` 的 `bundle/qodercli.js`
 *    (`npm pack` 解开)—— `new xn("login").description(\`Sign in to your ${…} account through
 *    the browser\`)`,调 `loginWithDeviceFlow()` 拿 `{authUrl, loginComplete}`,先印
 *    「Please open the following URL in your browser to sign in:」+ URL,再等授权;
 *  · 文档同源:`https://docs.qoder.com/cli/cli-reference.md:137` —— `| login | Sign in to your
 *    account. |`;`https://docs.qoder.com/cli/authentication.md` 里 `/login` 那条也是同一件事
 *    (TUI 里的 slash 入口,别名 `/signin`)。
 *
 * ⇒ 咕咕给的是**非交互的那一条**(`qodercli login`):它在无图形界面时会直接把登录 URL 印出来
 *   (文档原文:「automatically skips launching the browser, and the sign-in screen prints the
 *   sign-in URL directly」),内嵌终端里自足 —— ❌ 不给 `/login`:那要用户先自己进 TUI 再打字。
 *
 * ⚠️ qoder 正是 `vendorAccount: 'required'` 那一家,它的实测依据里那句
 *   `Not logged in · Please run /login` 就是这条闸 —— 所以这个入口不是锦上添花,
 *   没有它用户只被告知「需要登录」而无处可去。
 */
export const QODER_LOGIN_METHOD_ID = 'qoder-login';

/** PAT 的环境变量名 —— 官方文档 `https://docs.qoder.com/cli/authentication.md`。 */
export const QODER_PAT_ENV = 'QODER_PERSONAL_ACCESS_TOKEN';

/**
 * 「登没登 Qoder 账号」。
 *
 * · PAT 在环境里 → `authenticated`。文档原文:同时有 PAT 和 `/login` 时,
 *   「authentication **uses the PAT from the environment variable first**」⇒ 有它就一定走得通。
 * · 其余一律 `unknown`,❌ 不报 `unauthenticated`。
 *   浏览器登录后的凭据落在一个**带命名空间的凭据仓**(发行包里那条 `com.qoder/auth-state-v1`),
 *   不是一条查得到的文件路径 —— 咕咕这边没有任何能判死「没登录」的一手判据。
 *   报 `unauthenticated` 就是把「我查不到」说成「你没登」:一个恒定误报的判据比没有判据更坏。
 *
 * ⚠️ 「这位用户此刻登没登」这件事在产品里**另有**一条真判据 —— ACP 探针
 *   (`harness-model-catalog`)真起一次会话、被它拒了才记 `auth-required`。
 *   界面用的是那一条;这里这份只喂登录终端的「登上了没有、可以关窗了吗」。
 */
export async function qoderAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  if (ctx.env?.[QODER_PAT_ENV]?.trim()) return { kind: 'authenticated' };
  return {
    kind: 'unknown',
    message: `没有 ${QODER_PAT_ENV};浏览器登录的凭据不落在咕咕查得到的路径上,判不了。`,
  };
}

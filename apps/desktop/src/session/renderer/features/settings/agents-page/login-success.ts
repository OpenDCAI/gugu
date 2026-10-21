import type { AuthStatusModelState } from '@gugu/session-core/workspace-server/agent-config';

/**
 * 「**这次**登录成功了吗」—— 登录弹窗关窗的判据(#5705)。
 *
 * ## 为什么要把它从组件里抽出来
 *
 * 从前这个判断直接写在 `AgentSignInModal` 的 reaction 里,一行 `status.kind === 'authenticated'`。
 * 它读的是设置页那份**共享的**登录态复制状态 —— 不是这次登录尝试自己探出来的读数。而那条 reaction
 * 带着 `fireImmediately`,于是弹窗挂载的第一帧就拿这份**登录前**的旧读数判「成功」,当场关窗:
 *
 * - 凭据已经过期、但上一次探测还说「已登录」的人,点登录 → 弹窗开一帧就没了,他修不了;
 * - 想换个账号的人,同样开不起来。
 *
 * 判的其实是「上一次探测的结论」,不是「这次登录的结果」。⇒ 抽成一个纯函数,让这件事可判。
 */
export type LoginAttemptProgress = {
  /**
   * 挂载那一刻的那一次读数已经过去了。
   *
   * 这是全部的关键:弹窗挂载时 `startLogin` 已经跑过了,所以那一刻的取值**按定义**是登录前的,
   * ❌ 不能当成本次的结果。
   */
  readonly sawInitialReading: boolean;
};

export function loginAttemptSucceeded(
  state: AuthStatusModelState,
  progress: LoginAttemptProgress
): boolean {
  if (!progress.sawInitialReading) return false;
  return state.status.kind === 'authenticated';
}

/**
 * 首帧仍然要处理设备码流程的授权链接 —— 所以 `fireImmediately` 保留,❌ 不是把它去掉(#4900)。
 *
 * 同一个 URL 只处理一次:这份状态会因为别的字段变化被重发,重复弹「打开外部链接」确认
 * 会把用户从浏览器里那半程授权中打断。
 */
export function pendingUrlToOpen(
  state: AuthStatusModelState,
  handled: ReadonlySet<string>
): { id: string; url: string } | null {
  const pending = state.login?.pendingUrl;
  if (!pending || handled.has(pending.id)) return null;
  return pending;
}

/**
 * 登录窗口关掉(任何路径)时,要不要把那次登录也取消(#6264)。
 *
 *  · 本机:❌ 不取消(#4900)—— 设备码要人离开窗口去浏览器授权,`<cli> login` 得活着才收得到。
 *  · 别的机器:取消 —— 窗口没了就再没人盯着那台机器上的登录命令。已经登上的那一次由绑定自己放过
 *    (`RemoteAuthLoginBinding.dispose` 终局后不发取消)。
 */
export function cancelsLoginOnClose(target: { remote: boolean }): boolean {
  return target.remote;
}

/**
 * 协议登录(`acp-authenticate`)弹窗此刻该画什么 —— 纯函数,好判。
 *
 *  · `starting`:进程还没起来 / 登录态里还没有这一趟;
 *  · `waiting`:厂商已经在拉浏览器,等用户在那边点完;
 *  · `failed`:厂商或进程给了失败结局 —— 原话带上(`authenticate: …` 那一串就是厂商自己的错误)。
 * `cancelled` 不画任何东西:那是用户自己点的。
 *
 * `fallbackUrl` 是厂商打在 stderr 里的登录链接,只作「浏览器没打开就点这里」的备用。
 */
export type AcpLoginView =
  | { phase: 'starting'; fallbackUrl: null }
  | { phase: 'waiting'; fallbackUrl: string | null }
  | { phase: 'failed'; message: string; fallbackUrl: null };

export function acpLoginView(state: AuthStatusModelState): AcpLoginView {
  const login = state.login;
  if (!login || login.transport !== 'acp-authenticate') return { phase: 'starting', fallbackUrl: null };
  if (login.outcome?.kind === 'failed') {
    return { phase: 'failed', message: login.outcome.message, fallbackUrl: null };
  }
  return { phase: 'waiting', fallbackUrl: login.pendingUrl?.url ?? null };
}

/**
 * 协议登录「这一趟成了」—— 比 `loginAttemptSucceeded` 多一个条件:**这一趟已经收尾**(`login` 清空)。
 *
 * 为什么要多这一条:想「重新登录」的人本来就是 authenticated,而协议登录等浏览器期间登录态会因为
 * 备用链接那一格变化而重发 —— 只看 `authenticated` 的话,弹窗会在他还没去浏览器点的时候就自己关掉。
 * 运行时在这一趟结束、重读到 authenticated 时才把 `login` 清成 null(`updateStatus`),那一刻才算数。
 */
export function acpLoginAttemptSucceeded(
  state: AuthStatusModelState,
  progress: LoginAttemptProgress
): boolean {
  return loginAttemptSucceeded(state, progress) && state.login === null;
}

/**
 * 终端登录要不要在用户**回到窗口**时再问一次登录态(#6335)—— 只看这一趟开始时的那一次读数。
 *
 * 从「没登上 / 判不出」开始 ⇒ 要:有的家登完不退出(`agy` 停在自己的输入框里),退出这个事件等不来,
 * 回到窗口那一下就是「我在浏览器里点完了」最自然的信号(一次回来一次读数,❌ 轮询)。
 * 从「已登录」开始(重新登录 / 换账号)⇒ 不要:那时重读只会读到旧凭据,弹窗会在他换完之前自己关掉。
 */
export function rereadOnReturn(initial: AuthStatusModelState): boolean {
  return initial.status.kind !== 'authenticated';
}

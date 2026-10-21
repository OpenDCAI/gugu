type AccessTokenReader = () => Promise<string | null>;

let readAccessToken: AccessTokenReader | null = null;

/**
 * 主进程在启动时把「怎么拿当前账号的令牌」交进来。
 *
 * 为什么要注入而不是自己去取:GoTrue 的会话本体在渲染进程里(见 runtime-auth-provider.ts),
 * 主进程只能问它。会话页这一侧不该自己再造一条问法 —— 两条问法就会有两种「没登录」的判断。
 */
export function setAccountAccessTokenReader(reader: AccessTokenReader): void {
  readAccessToken = reader;
}

/**
 * The same reader, for every session-page consumer of the account's token (the App file sync relay,
 * App files, sends). One way of asking, one notion of "not signed in". `null` = not signed in, or not wired yet.
 */
export async function currentAccountAccessToken(): Promise<string | null> {
  return readAccessToken ? await readAccessToken() : null;
}

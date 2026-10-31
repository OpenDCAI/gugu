import type { FileRef, ResolvedFile } from '@gugu/core/shared/fileResolver';
import type { ChatFileRef, FilesPlatform } from '@shared/extensions/app-files-core';

type AccessTokenReader = () => Promise<string | null>;

let readAccessToken: AccessTokenReader | null = null;
type AccountFileResolver = (ref: FileRef | ChatFileRef, actor?: string | null, options?: Parameters<NonNullable<FilesPlatform['resolveFile']>>[2]) => Promise<ResolvedFile | null>;
let fileResolver: AccountFileResolver | undefined;
let publishFile: NonNullable<FilesPlatform['publishFile']> | undefined;
export const setAccountFileResolver = (resolve: AccountFileResolver, publish?: NonNullable<FilesPlatform['publishFile']>) => { fileResolver = resolve; publishFile = publish; };
export const publishAccountFile: NonNullable<FilesPlatform['publishFile']> = (...args) => { if (!publishFile) throw new Error('Account file publisher is not installed'); return publishFile(...args); };
export const resolveAccountFile: AccountFileResolver = (ref, actor, options) => {
  if (!fileResolver) throw new Error('Account file resolver is not installed');
  return fileResolver(ref, actor, options);
};

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

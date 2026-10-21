import { z } from 'zod';

/**
 * 「这一家跑哪一份 CLI」—— 主进程的答案(#5681 / #5683)。
 *
 * 用户在 Agents 设置里选的那份拷贝(path / pinned / method / cli)只有主进程读得到;worker 进程自己
 * 探测只会拿到 PATH 上赢的那份 —— 选了 `claude2` 这类切账号 wrapper 的用户,就会一边跑 A、一边跑 B。
 * ⇒ 凡是 worker 里要跑 CLI 的地方(ACP 会话起适配器、登录、登录状态、凭据判断),都由主进程用与
 * 终端腿同一个解析器算好递进来,worker 照用、❌ 不再自己找。
 * 解析失败也是一个答案:带着解析器自己的诊断原文,在调用边界响亮报出。
 */
export const hostCliSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('resolved'), path: z.string().min(1) }),
  z.object({ kind: z.literal('unresolved'), message: z.string().min(1) }),
]);
export type HostCli = z.infer<typeof hostCliSchema>;

/** 在途去重的键:同一家换了一份 CLI,就是另一次读数,❌ 不许并进同一个结果。 */
export function hostCliKey(hostCli: HostCli): string {
  return hostCli.kind === 'resolved' ? `path:${hostCli.path}` : `unresolved:${hostCli.message}`;
}

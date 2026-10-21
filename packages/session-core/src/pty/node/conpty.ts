/**
 * @@@conpty-passthrough — Windows 自带的 ConPTY 不是透明管道。
 *
 * TUI 启动时会问终端「你的前景/背景色是多少」(OSC 10/11),按回答挑明暗配色。
 * 系统 ConPTY 把这个查询**既不转发给宿主、也不自己回答**(把回答写进输入流同样被丢掉),
 * 于是这类 TUI 在 Windows 上永远探不到咕咕的底色,超时后回落深色 —— 浅色终端里
 * 出现一个 #292929 的输入框。macOS 的 pty 是透明管道,同一个查询原样到达 xterm.js
 * 并被回答;**两端配色不一致的全部来源就是这一条**。
 *
 * node-pty 随包带了 Windows Terminal 那份 ConPTY,它原样转发全部查询。
 * 2026-09-19 chole(Windows 11)实测,同一版 codex 0.155.1、同一份 env、同一条命令:
 *   系统 ConPTY    OSC 10/11 一个字节都没出来 → 输入框 `48;2;41;41;41`
 *   自带 conpty.dll 查询原样转发、宿主回答后   → 输入框 `48;2;244;244;244`(与 macOS 逐字相同)
 *
 * ⚠️ 它也把 DA1 / DA2 / CPR / DECRQM 一并交回宿主(从前由 conhost 代答)⇒ 宿主那一侧
 * 必须真的会回答。xterm.js 原生答前三个,DECRQM 由 `pty.ts` / `use-pty.ts` 的 #4904 绕行答。
 *
 * 非 Windows 平台 node-pty 忽略本选项。
 */
export const CONPTY_SPAWN_OPTIONS = { useConptyDll: true } as const;

/**
 * @@@conpty-worker-release (#6629) — 自带 conpty.dll 这条分支的另一笔账。
 *
 * node-pty 1.1.0 为每个 pty 起一个 worker_thread,把 conout 管道转进宿主这边的输出 socket。
 * 在 useConptyDll 分支上,它只在「kill 之后又来一次输出」时才终止这个 worker(microsoft/node-pty#977),
 * 进程自己退出时从不终止。留下的 worker 只剩一个监听中的命名管道,每个 ~10 MB 提交;
 * owner 在役实例跑 23 h 攒了 102 个(活着的 ConPTY 只有 6 个)。
 *
 * 输出 socket 一关(node-pty 正是在那一刻发 exit),worker 就无事可做 ⇒ 在 exit 上交还它;
 * 它自己的 dispose 会再等一个排空间隔才 terminate。两条 spawn 路径都必须挂上。
 * `_agent._conoutSocketWorker` 是 node-pty 的私有字段:形状由 conpty.test.ts 钉在已装版本上;
 * winpty 那条分支没有这个 worker。
 */
type ConoutWorkerOwner = {
  onExit(listener: () => void): unknown;
  _agent?: { _conoutSocketWorker?: { dispose(): void } };
};

export function releaseConoutWorkerOnExit(
  proc: object,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') return;
  const owner = proc as ConoutWorkerOwner;
  owner.onExit(() => owner._agent?._conoutSocketWorker?.dispose());
}

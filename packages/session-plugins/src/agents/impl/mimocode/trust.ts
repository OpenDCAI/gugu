import type { RuntimeArgvTrustBehavior } from '@gugu/session-core/agents/plugins';

/**
 * mimocode 的工作区信任走 **argv**,不落盘 —— 用户的
 * `~/.local/share/mimocode/trusted-workspaces.json` 一个字节都不动。
 *
 * ## 取证(@mimo-ai/cli 的平台二进制,2026-09-04,#4975)
 *
 * 交互式 TUI(默认命令,咕咕 tui 腿 spawn 的就是它)带一个官方旗标:
 * `--trust  skip workspace trust prompt and trust the directory  [boolean] [default: false]`
 * —— `mimo --help` 原文;0.1.8 / 0.1.12 / 0.1.13 / 0.1.14 四个版本的二进制逐个
 * `strings | grep 'skip workspace trust prompt'` 各命中 1 次,已发布的其余版本介于两端。
 *
 * 启动路径(0.1.14 字节层,minified):
 * `if(!A.trust){let f=await lY0(Q);if(f!=="trusted"){if(!await zB2(Q,f))return;…}}`
 * —— `A.trust` 为真时整个信任判定被跳过:不读 `trusted-workspaces.json`,也**不写**它
 * (答「是」走的 `iY0` 持久化路径根本不执行)。所以这条通道比用户在门里亲手答
 * 「是的,我信任此目录」更窄:后者会把路径**永久**追加进全局信任文件,这条只对本次 spawn 生效。
 *
 * ## 为什么替用户跳这道门是正当的(#4975 交付判据 2 的举证义务)
 *
 * 1. 门问的是「这是你自己创建或信任的项目吗」,而 session-TUI 腿的 cwd 是**咕咕自己物化**的
 *    task workspace(task-home / 用户选定项目的 worktree)—— 创建者就是产品自己。
 * 2. 只在产品既有的 auto-trust 政策闸内发生:`WorkspaceTrustService` 的
 *    `autoTrustWorktrees` 设置(设置页可见,可关)或 auto-approve force —— 与
 *    claude(runtime-env)/ kimi(first-run-state)/ codex(session toml overlay)同一道闸,
 *    mimocode 是 #4834 归运行时注入后唯一掉队的一家(capability-bundle spec 原文点名四家)。
 * 3. 关着 auto-trust 时什么都不给:mimocode 走它自己的原生信任门,用户在终端里亲自答,
 *    写的是它自己的全局信任文件 —— 那是引擎自己的行为,不是咕咕的落地写。
 *    (那道门此时由 provider-blocker 显形,见 provider-review-gate.ts 的 mimocode 条目。)
 *
 * ⚠️ 这是引擎的公开 CLI 面(`--help` 列出),不是内部约定;换版仍复查:
 *    `strings <mimo二进制> | grep -c 'skip workspace trust prompt'` ≥ 1,产品面判据是
 *    e2e `fresh-home-trust-preflight-4763.spec.ts` 的 mimocode-tui 格(全新 HOME 首句必须被接纳)。
 */
export const MIMOCODE_TRUST_ARGS = Object.freeze(['--trust'] as const);

export function buildMimocodeTrustBehavior(): RuntimeArgvTrustBehavior {
  return {
    channel: 'runtime-argv',
    trustArgs: () => [...MIMOCODE_TRUST_ARGS],
  };
}

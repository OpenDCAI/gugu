/**
 * 以 **root** 跑咕咕时,claude 的 ACP 腿(Chat 视图)会把「完全访问」这一档整个藏起来 ——
 * 这一手把它拿回来。
 *
 * ## 形状
 *
 * 同一台机器、同一个 claude 二进制:TUI 腿选「完全访问」正常,Chat 视图必炸,报
 * `Provider 'claude' did not expose a permission mode matching 'full-access'`。
 * 那句是 `applyConfiguredPermissionMode` 的**设计内**响亮失败(❌ 不该软化:静默降档会把
 * 用户选的「完全访问」变成「改文件前问我」甚至「根本不能改」),真正的错在它前一步 ——
 * 档位表里本就没有那一档。
 *
 * ## 判据(桥的源码,根 package.json 钉的 `@agentclientprotocol/claude-agent-acp` 0.54.1)
 *
 * `dist/acp-agent.js:104-105` 逐字:
 *   `// Bypass Permissions doesn't work if we are a root/sudo user`
 *   `const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;`
 *   `const ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX;`
 * 它在两处消费:`buildAvailableModes()`(`if (ALLOW_BYPASS)` 才 push
 * `{ id: "bypassPermissions" }`)与 `:2579` 的 `allowDangerouslySkipPermissions: ALLOW_BYPASS`。
 * ⇒ root 下 `session/new` 只报 5 档,`full-access` 无处可落。
 *
 * ⚠️ ❌ **不是** `skipDangerousModePermissionPrompt` / `bypassPermissionsModeAccepted`:
 * 那两个键在整座桥里出现 **0 次**(阳性对照:同文件 `disallowedTools` 命中 3 次)。它们是 TUI 腿
 * 免责声明对话框的标记(sessionpage-platform-model.ts),与 ACP 的档位表没有关系。
 *
 * ## 这不是放开厂商的安全闸,是把两条腿拉回一致
 *
 * 桥的这道闸比**它自己驱动的那个 CLI** 更严。实测(d22,root,IS_SANDBOX 未设,claude 2.1.261):
 * `claude -p --dangerously-skip-permissions` 真的绕过了 —— 0 次询问、目标文件写成,模型还
 * 逐字引用了会话里的 bypass 指令。所以咕咕的 TUI 腿在 root 上一直是完全访问,只有 ACP 腿被
 * 桥单方面降档。
 *
 * ## A/B(d22 root · claude 2.1.261 · 桥 0.54.1,2026-09-05;判据是**行为**不是档位表)
 *
 * · 基线:`modes=[auto,default,acceptEdits,plan,dontAsk]`,`session/set_mode(bypassPermissions)`
 *   被拒(Internal error),探针文件没写。
 * · `IS_SANDBOX=1`:档位表多出 `bypassPermissions`,`set_mode` ok,**0 次**
 *   `session/request_permission`(客户端一律答 reject,有询问就写不成),探针文件写成。
 * 两个读数都双向变过,单变量。
 *
 * ## 为什么落在进程级、不按会话给
 *
 * 每条会话都拥有自己的 ACP adapter 进程；用户仍可在会话中途 `setMode` 切档。**可用性**只能是
 * 进程级的,**选哪一档**仍留在会话级 —— 这正是 ACP 自己的模型。知情同意仍由产品面把关:
 * 咕咕只在用户在界面上选了「完全访问」时才去选中它(同 TUI 腿传 `--dangerously-skip-permissions` 的那一下)。
 *
 * ## 为什么只在 euid==0 时给
 *
 * 非 root 上 `ALLOW_BYPASS` 本来就是 true,再给只会平白让 claude 以为自己在沙箱里 ——
 * 它自己另有两处读这个键(`probeContainedNoInternet`、`disableNoSandbox` 那条),没有理由把
 * 副作用摊给绝大多数用户。取 `'1'` 而不是任意真值:桥收任意真值,claude 本体的
 * `isSandboxEnvSet()` 严格要 `=== "1"`,`'1'` 同时满足两边。
 *
 * ⚠️ 换版必复查:桥若换了判据(改读别的 env、或直接删掉这道闸),这一手会**静默失效**,
 * 症状退回「root 上选完全访问必炸」。复查一招:`grep -n "ALLOW_BYPASS" dist/acp-agent.js`。
 *
 * ⚠️ 测试缝是 **euid 的取法**(一个函数)而不是 euid 本身:默认参数只在实参为 `undefined` 时
 * 才生效,于是「这台机器没有 uid 语义」(Windows,两个 getter 都不存在 ⇒ 表达式求值成
 * undefined)那一格用值传不进来 —— 传 undefined 会被默认值顶掉,在 root 开发机上反判成 root。
 */
export function claudeAcpRootBypassEnv(
  readEuid: () => number | undefined = () => process.geteuid?.() ?? process.getuid?.()
): Record<string, string> {
  return readEuid() === 0 ? { IS_SANDBOX: '1' } : {};
}

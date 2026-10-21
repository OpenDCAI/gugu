import type { RuntimeEnvTrustBehavior } from '@gugu/session-core/agents/plugins';

/**
 * claude 的工作区信任走 **env**,不落盘 —— 用户的 `~/.claude.json` 一个字节都不动。
 *
 * ## 取证(claude 2.1.259 原生二进制,`/root/.local/share/claude/versions/2.1.259`,2026-09-03)
 *
 * 信任判定函数(minified 名 `Mue`)原文:
 * `function Mue(){if(a.CLAUDE_CODE_SANDBOXED)return!0;if(k6())return!0;if(St())return!0;
 *   let e=ie(),n=J1e();if(e.projects?.[n]?.hasTrustDialogAccepted)return!0;return LF(e,_e())}`
 * —— `CLAUDE_CODE_SANDBOXED` 与「`.claude.json` 里 `projects[cwd].hasTrustDialogAccepted`」
 * 是**同一个判定的两个入口**;托管侧当年写进影子 `.claude.json` 的正是后者。
 * 全二进制 `CLAUDE_CODE_SANDBOXED` 只有 3 处读取:上面这条、项目级 permission 授权门
 * (`MEn`,同形)、切目录时的提示文案 —— 没有别的副作用。
 *
 * 首启向导(主题选择,#4765 「首句被吞」的那个)与信任对话框在同一个启动函数里被 `IS_DEMO` 一起跳过:
 * `if($e(!1)||a.IS_DEMO)return us(O),Ast(),{onboardingShown:!1,…}` 排在
 * `if(!I.hasCompletedOnboarding…)` 与 `TrustDialog` 之前;`us()` 在已可信时把 session 标成
 * trusted(`QI(!0)`)并做 post-trust 初始化。`IS_DEMO` 另外 2 类副作用:状态栏不显示
 * 组织名 / 邮箱、fleet fork 关闭 —— 会话页里都用不上。
 *
 * ⚠️ 两个变量**必须同进同出**:只给 `IS_DEMO` 会连信任对话框一起跳过、而工作区仍不可信 ——
 *    项目 settings / hooks / MCP 被静默忽略,且会话内没有第二个入口再授信。
 * ⚠️ 正因为要同进同出,这两个名字都**不在**透传名单上(在 `shellEnv.denied`)(IS_DEMO 曾在,#4876 摘掉):
 *    用户 shell 里碰巧 export 一个,会把另一半漏掉。
 * ⚠️ 这两个都是引擎内部约定、文档没写。换版必复查:`strings <claude> | grep -c CLAUDE_CODE_SANDBOXED`
 *    ≥ 3 且 `IS_DEMO` 仍在启动函数那条判定里;e2e `fresh-home-trust-preflight-4763.spec.ts` 的
 *    claude-tui 格是产品面的判据(全新 HOME 首句必须被接纳)。
 *
 * 关着 auto-trust 时什么都不给:claude 走它自己的原生首启(向导 + 信任对话框),用户在终端里
 * 亲自答,写的是 claude 自己的文件 —— 那是引擎自己的行为,不是咕咕的落地写。
 */
export const CLAUDE_TRUST_ENV = Object.freeze({
  CLAUDE_CODE_SANDBOXED: '1',
  IS_DEMO: '1',
});

export function buildClaudeTrustBehavior(): RuntimeEnvTrustBehavior {
  return {
    channel: 'runtime-env',
    trustEnv: () => ({ ...CLAUDE_TRUST_ENV }),
  };
}

import { join } from 'node:path';
import type { SessionpageSessionSurface } from '@gugu/session-core/agents/plugins';

/**
 * @@@pi 配置根 - **唯一**的计算处;`models.json` / `settings.json` / 事件模块 / npm 安装 /
 * sessions 全部从 `piAgentDir()` 派生。❌ 本包任何别处再出现 `.pi/agent` 这种字面量。
 * 单独成文件、不引别的模块：宿主的时间线读侧(`locate.ts`)也从这里取 sessions 的位置。
 *
 * **根必须逐腿分开,这就是本次回归的修法。** pi 认两种扩展安装,而它们落在同一个根的两个位置:
 *  · argv `--extension npm:…`(终端腿)= run-only 临时装 ⇒ `<root>/tmp/extensions/npm/<hash>/…`
 *    (pi `docs/packages.md`:"try a package without installing it … for the current run only");
 *  · settings.json 的 `packages:[…]`(ACP 腿,它递不进 argv)= 持久的 user-scope 装 ⇒ `<root>/npm/…`。
 * pi 只在 global-vs-project settings 之间按包名去重,**`-e` 临时装与 settings 装之间没有任何去重**;
 * 而 `detectExtensionConflicts` 按 `ext.path` 认所有者 ⇒ 同一个根下两份路径不同的 adapter 一起加载,
 * 当场 `Tool "mcp" conflicts with …`,回合起不来。⇒ 两条腿只要不共用根,这件事结构上不可能发生。
 * ⚠️ ❌ 别改成「装之前先看那一份在不在」:那是 check-then-act,两个所有者还在,换个启动顺序就撞回来。
 *
 * 根的**位置**是咕咕自己选的,不是 pi 强制的 —— pi `docs/environment-variables.md`:
 * `PI_CODING_AGENT_DIR` "Override the config directory; default is `~/.pi/agent`"
 * (`dist/config.js` 的 `getAgentDir()`:有该环境变量就用它,否则才回落 `~/.pi/agent`)。
 */
export const PI_CONFIG_DIR_NAME = '.pi';

/**
 * 逐腿的配置根叶名 —— **两条腿必须不同**。
 * 终端腿沿用 pi 自己的默认叶名(与 dev 上逐字一致,那条腿的既有 profile 不迁移);
 * ACP 腿单独一个,于是它持久装的 adapter 对终端腿**不可见**。
 */
export const PI_AGENT_DIR_LEAF: Record<SessionpageSessionSurface, string> = {
  'tui': 'agent',
  'acp': 'acp-agent',
};

/** 这条腿的 pi 配置根。**所有**与 pi 配置根有关的路径都必须经这里,❌ 别再拼字面量。 */
export function piAgentDir(surface: SessionpageSessionSurface, guguHome: string): string {
  const home = guguHome.trim();
  if (!home) throw new Error('Pi session bundle requires GUGU_HOME');
  return join(home, PI_CONFIG_DIR_NAME, PI_AGENT_DIR_LEAF[surface]);
}

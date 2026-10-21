import type { SessionAutonomyCapability } from '@gugu/session-core/agents/plugins';

/**
 * opencode 系（opencode 本体 + 它的品牌化 fork MiMo-Code）把「这次会话允许 agent 自己做到哪一步」
 * 写进配置文档的那段形状。
 *
 * ## 厂商的机制（2026-08-25 实测 opencode-ai@1.18.23 / @mimo-ai/cli@0.1.13）
 *
 * 配置键 `permission`，动作枚举 `"ask" | "allow" | "deny"`。可以写成
 *   · **裸字符串** —— 归一化成 `{ "*": <action> }`
 *   · **对象** —— `{ <工具键>: <action> | { <pattern>: <action> } }`
 * 规则按 pattern 匹配，官方原文「Rules are evaluated by pattern match, with the
 * **last matching rule winning**」；用户规则 append 在内置默认之后，所以后写的赢。
 * JSON 的键序即优先级（schema 注释 `propertyOrder: "original"`）。
 *
 * 内置默认**几乎全放行**：编译出的 ruleset 第 0 条就是 `* | * -> allow`，只有
 * `doom_loop`、`external_directory`、`read *.env` 是 ask。
 *
 * ## ⚠️ 这一家的 fail-open 坑，以及为什么这个文件要存在
 *
 * `permission` **块内**的键是个 catch-all `Record`，**打错字会被接受**。实测
 * `{"permission":{"bahs":"deny","edit":"deny"}}` 编译出一条 `bahs | * -> deny` 的
 * **永不匹配**规则，退出码 0、`--log-level=DEBUG` 也没有一行 warning，而 `tools.bash`
 * 仍然是 `true` —— 你以为封了 shell，其实全开。**方向是 fail-open**。
 *
 * 反过来，JSON 语法错、动作值非法（`"allowed"`）都是 fail loud
 * （`Expected PermissionActionConfig, got "allowed" permission.bash`）。
 * 所以**唯独「键名」这一层没有保护** ⇒ 咕咕自己补上：这里把每个要写出去的键
 * 对着从厂商源码逐字转录的全集校验，不在集合里就抛。厂商的 fail-open 到咕咕这一侧变成 fail-loud。
 *
 * 这不是假想的洁癖：两家的键集**本来就不一样**（MiMo 多 `actor`/`codesearch`/`bash_delete`，
 * 少 `todowrite`）。把 opencode 的配方原样搬给 MiMo，`todowrite` 那条就是一条永不匹配的死规则，
 * 而且一声不吭。
 *
 * ❌ 别绕过这个函数直接拼 `permission` 块。
 */
export type OpenCodeFamilyPermissionAction = 'ask' | 'allow' | 'deny';

export interface OpenCodeFamilyPermissionSpec {
  /** 报错串里的人类可读名，例如 `OpenCode` / `MiMo-Code`。 */
  readonly displayName: string;
  /**
   * 这一家 `permission` 块合法的工具键**全集**，从厂商源码
   * `packages/core/src/v1/config/permission.ts` 逐字转录。
   *
   * ⚠️ 这是一份**会过期**的转录件：厂商加一个工具键、这里不跟，只是少管一样东西（安全方向）；
   * 但厂商**改名或删掉**一个键而这里还写着，那条规则就变成永不匹配的死规则 —— 那才是危险方向。
   * 升级 supportedFloor 时对着源码重核一遍。
   */
  readonly toolKeys: readonly string[];
  /**
   * `approval-required` 档要显式收紧的键（见下面 `openCodeFamilyPermissionConfig` 的注释）。
   * 必须是 `toolKeys` 的子集，否则构造时就炸。
   */
  readonly approvalGatedKeys: readonly string[];
}

/**
 * 把咕咕的自治档位落成 opencode 系的 `permission` 配置。
 *
 * 咕咕只建模两档（`SessionAutonomyCapability.mode`），映射对齐 **codex 那一家的同名档**
 * —— 同一个档在不同引擎上得是同一个意思，否则用户选的「需要审批」在这家是每读一个文件都弹窗、
 * 在那家是随便读，那这个档就没有意义了。codex 的对照组是
 * `approval_policy=on-request` + `sandbox_mode=workspace-write`：读自由、工作区内写自由、越界才问。
 *
 * · `full-access` → `permission: "allow"`（**裸字符串**）
 *
 *   写成裸字符串是刻意的：它**一个键都没有**，于是结构上免疫上面那个 typo fail-open 坑。
 *   它归一化成 `{"*":"allow"}` 并压过内置默认的 `doom_loop`/`external_directory`/`read *.env`
 *   三条 ask —— 对这一档来说这正是要的，「完全访问」就该是完全访问。
 *
 * · `approval-required` → 只 append 若干条 `ask`，**不写 `"*"`**。
 *
 *   ❌ 这里**故意不写** `{"*":"allow", ...}`：`"*"` 会排在内置默认之后，把厂商刻意设的
 *   `read *.env -> ask`（读密钥文件要问）一并盖掉。放着不写，那三条内置 ask 原样保留，
 *   而其余非破坏性工具（`read`/`glob`/`grep`/`list`/`lsp` …）本来就落在默认的 `* -> allow` 上，
 *   效果与 codex 的「读自由」一致，还白捡了厂商的密钥护栏。
 *
 *   收紧哪些（`approvalGatedKeys`）：
 *   · `bash` —— **这一家没有任何 OS 级沙箱**（两仓源码搜 `sandbox-exec`/`seatbelt`/`landlock`/
 *     `bwrap`/`firejail`/`nsjail` 全 0 命中，同一把尺子下阳性对照 `external_directory` 有上百处，
 *     证明仪器有效）。codex 那边靠 `workspace-write` 把 shell 关进笼子，这边关不了 ⇒
 *     **无沙箱的 shell 本身就是逃逸面**，只能靠问。
 *   · `webfetch` / `websearch` —— codex 的 `workspace-write` 默认断网，这是同一语义的对应物。
 *   · `external_directory` / `doom_loop` —— 内置默认已经是 ask，这里**再写一遍**不是冗余：
 *     写死了就不随厂商默认漂移，将来它把默认翻成 allow 也影响不到咕咕这一档。
 *
 * ⚠️ MiMo 的 `bash_delete` 是 `FORCED_ASK`：`{"*":"allow"}` 和 skip-all 都**豁免不掉**它。
 *    所以 `full-access` 在 MiMo 上删文件仍会问一次。咕咕**不去覆盖它** ——
 *    `MIMOCODE_AUTO_APPROVE_DELETE` 是另一根轴，用户从没表达过要开它，而「删文件要确认」
 *    恰恰是最该留的地板。这是厂商侧比请求更严的下限，不是咕咕没接通。
 *
 * ⚠️ 这段配置最终经 `*_CONFIG_CONTENT` 下发。还有一条优先级**更高**的 `OPENCODE_PERMISSION` /
 *    `MIMOCODE_PERMISSION`（只吃权限、merge 在最后）。❌ 没走它是刻意的：它会**静默压过**
 *    用户自己在 config 里写的 permission；走 config 文档则由各家的 owned-config merge
 *    撞见冲突时响亮地炸，用户能看见「你和咕咕都在管这件事」。
 */
export function openCodeFamilyPermissionConfig(
  spec: OpenCodeFamilyPermissionSpec,
  autonomy: SessionAutonomyCapability | null,
): Record<string, unknown> {
  if (!autonomy) return {};

  const unknown = spec.approvalGatedKeys.filter((key) => !spec.toolKeys.includes(key));
  if (unknown.length > 0) {
    // 厂商会照单全收并编译成永不匹配的死规则，所以只能咕咕自己在这里拦。
    throw new Error(
      `${spec.displayName} session adapter refuses unknown permission key(s): ${unknown.join(', ')}`,
    );
  }

  if (autonomy.mode === 'full-access') return { permission: 'allow' };

  const permission: Record<string, OpenCodeFamilyPermissionAction> = {};
  for (const key of spec.approvalGatedKeys) permission[key] = 'ask';
  return { permission };
}

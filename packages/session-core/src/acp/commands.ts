/**
 * A slash command's **token** — the exact text the agent has to receive to run it.
 *
 * # 为什么这不是「名字前面加个斜杠」
 *
 * ACP 的 `AvailableCommand.name` 不保证是个裸词：**当一家 agent 自己的调用语法带 sigil 时，
 * 它把 sigil 一起报进 name**。codex 就是活例子 —— 它把 skill 列成 `$my-skill`，因为
 * `$my-skill` 正是 codex 会展开的那个 token（官方文档 `learn.chatgpt.com/docs/cli/skills`：
 * “use the `$` prefix to invoke skills”）。`codex-acp` 自己也认这条：`parseCommand` 剥掉前导
 * `/` 之后看到 `$` 开头就 `{handled:false}`，把原文原样交给模型。
 *
 * ⇒ 在这种名字前面再补一个 `/`，发出去的是 `/$my-skill` —— 两边都匹配不上，命令静默退化成
 * 一句普通的话。实测三家（claude-agent-acp 0.54.1 / codex-acp 1.3.0 / opencode 1.18.25）：
 * claude 与 opencode 报裸名，codex 的 skill 全部带 `$`。
 *
 * # 规则说的是名字，不是厂商
 *
 * **名字自己带了 sigil，名字就是 token；裸名才配上用户敲的那个 `/`。**
 *
 * ❌ 不许按 `providerId` 分叉。那会把一条协议契约写成一家的补丁，下一家换个 sigil 就要再漏一次；
 * 而按名字判在今天这三家上给出的答案与按厂商判**逐条相同**，却对没见过的第四家仍然成立。
 */

/** 首字符既不是字母也不是数字/下划线 ⇒ 它是名字自带的 sigil。 */
const LEADING_SIGIL = /^[^\p{L}\p{N}_]/u;

/** 发给 agent 的原文。裸名 `review` → `/review`；带 sigil 的 `$skill` → `$skill`。 */
export function commandToken(name: string): string {
  if (!name) return '';
  return LEADING_SIGIL.test(name) ? name : `/${name}`;
}

/**
 * 这条 prompt 文本是不是在**唤起 agent 真的报过的那条命令**。
 *
 * 判据只有一条:文本第一个 whitespace-delimited token,逐字等于某条 advertised 命令的
 * `commandToken`。❌ 不许只看「以 `/` 开头」——
 *  · opencode 的 ACP 腿对**任何**以 `/` 开头的 prompt 都走命令分支,名字不认识就
 *    既不当命令跑、也不当文本发,直接 `end_turn` 收尾。于是 `/Users/foo 这个文件…`
 *    这种以路径开头的话会被静默吞掉。
 *  · 反过来,只按 `/` 判也会把裸 `$` 开头的 codex skill 漏掉。
 *
 * 用真名单判,两边都对,而且它对没见过的第四家同样成立。
 *
 * # 名单还是空的那一刻
 *
 * `available_commands_update` 是**会话建立之后**才到的,而用户完全可以在它到达之前就发出
 * 第一条。这时名单为空 —— 那是「**还不知道**」,不是「这一家没有命令」。此时逐字判会把
 * 一条真命令判成散文,而这条函数存在的全部意义就是不让那件事发生。
 *
 * ⇒ 名单为空时退回**语法**判据(首 token 自带 sigil)。它的已知代价是
 * `/Users/foo 这个文件…` 这类路径开头的话会被误判 —— 但那只影响块序(文本排到附件之前),
 * 同一条用户消息里的内容一个字都没变;而判错方向的另一边(真命令退化成散文)是功能直接不生效。
 * **名单一到,立刻回到逐字判**,误判窗口只有那一小段。
 */
export function invokesCommand(
  text: string,
  commands: readonly { readonly name: string }[]
): boolean {
  const head = text.trimStart().split(/\s/, 1)[0] ?? '';
  if (!head) return false;
  if (commands.length === 0) return LEADING_SIGIL.test(head);
  return commands.some((command) => commandToken(command.name) === head);
}

/**
 * @@@gugu-client-commands —— 咕咕**自己的**斜杠命令,不是 agent 报上来的。
 *
 * 面板里今天每一条都来自 ACP 的 `available_commands_update`;这一族不同:
 * **咕咕注入进面板、并在选中时拦下来,一个字都不发给 agent。**
 * (`sessionCommandSchema` 上那个 `source: 'provider-command'` 字段本来就是为加这一类留的。)
 *
 * ⚠️ id 与 name 在**这里**定义一次,注入侧与拦截侧都从这里取 ——
 * 两处各写一份字面量的那天,症状是「面板里有这条命令,点了没反应」,而且不会有任何报错。
 * 仓里已经有同族实账:同一个名字在四处各写一遍,对不上时 codex 得到 `-32603`,
 * 表现是一条永远「运行中」的 turn(见 `mcp/gugu-mcp-name.mjs`)。
 */
export const GUGU_CLIENT_COMMAND_MCP = 'gugu-client:mcp';

/** 这条命令是咕咕自己的吗(⇒ 拦下来,❌ 不发给 agent)。 */
export function isGuguClientCommand(id: string): boolean {
  return id.startsWith('gugu-client:');
}

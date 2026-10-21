import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type { AcpCommandDiscoveryContext } from '@gugu/session-core/agents/plugins';

/**
 * Antigravity 的用户 skill → 「/」面板(#6335)。
 *
 * ## 为什么要咕咕自己扫
 *
 * owner 2026-09-06(#5136)定的 skill 模型:用户自己装,咕咕只负责 invoke,入口是「/」面板。
 * 别家(claude / codex / opencode)把用户 skill 经 `available_commands_update` 报上来,咕咕零字节。
 * `agy_acp_server` 1.2.1 不报:探针放了 3 个 skill,`systemInstruction` 的「Available skills」里
 * 3 个都在(名字、说明、SKILL.md 绝对路径),命令表却只有 `plan` / `logout`(2026-09-24,
 * 隔离 `$GEMINI_HOME` + 本地假 Gemini 端点)。
 *
 * ## invoke 那一半
 *
 * 发 `/sk-ws …` 时服务端**不展开**(请求体里用户消息就是原文 `/sk-ws please run the skill`),
 * 由模型对照系统提示里的清单自己去读那份 SKILL.md —— 官方文档的「progressive disclosure」
 * (https://antigravity.google/docs/skills.md:「Activation: if a skill looks relevant to your task,
 *  the agent reads the full SKILL.md content」)。所以面板只需要把名字发出去。
 *
 * ## 扫哪几处 —— 服务自己写死的四处,一处不多
 *
 * 出处是服务自带的 `resolve_skills_paths(cwd)`(1.2.1 包内 Python 源码):写死四处,原样交给 SDK 的
 * `skills_paths`,❌ 不读 `config/skills.json`(那是 agy CLI 的 Go 语言服务器 `ScanSkillsConfigFile` 的功能,
 * ACP 服务包里没有这段):
 *  · `<cwd>/.agents/skills/<name>/SKILL.md`                  工作区
 *  · `<cwd>/.gemini/skills/<name>/SKILL.md`                  工作区(探针当时没放这处,读源码才补上)
 *  · `$GEMINI_HOME/config/skills/<name>/SKILL.md`            全局(官方文档的 2.0/IDE 全局位)
 *  · `$GEMINI_HOME/antigravity-cli/skills/<name>/SKILL.md`   CLI 的全局位,ACP 服务也读
 * 不认的两处:`$GEMINI_HOME/antigravity-acp/skills/`、`$GEMINI_HOME/antigravity/skills/`。
 * ❌ 别凭文档补第五处 —— 文档写的是 CLI / 2.0 / IDE 的行为,ACP 服务只认这四处(规则文件一处都不认)。
 *
 * `$GEMINI_HOME` 缺省是 `~/.gemini`(stderr「Gemini home resolved to … (from $GEMINI_HOME)」)。
 * env 取的是**启动它的那一份**,所以用户自己挪了根、或咕咕托管了根,扫的都是它真在读的那处。
 */
export const ANTIGRAVITY_SKILL_ROOTS = [
  { scope: 'workspace', relative: '.agents/skills' },
  { scope: 'workspace', relative: '.gemini/skills' },
  { scope: 'global', relative: 'config/skills' },
  { scope: 'global', relative: 'antigravity-cli/skills' },
] as const;

export async function discoverAntigravitySkills(
  ctx: AcpCommandDiscoveryContext
): Promise<AvailableCommand[]> {
  const geminiHome = ctx.env.GEMINI_HOME?.trim() || joinPath(ctx.homeDir, '.gemini');
  const commands: AvailableCommand[] = [];
  const seen = new Set<string>();
  // 工作区排前:同名时工作区那份压过全局那份(与别家「更近的作用域赢」同向)。
  for (const root of ANTIGRAVITY_SKILL_ROOTS) {
    const base = joinPath(root.scope === 'workspace' ? ctx.cwd : geminiHome, root.relative);
    for (const folder of (await ctx.fs.listDirs(base)).sort()) {
      const text = await ctx.fs.readText(joinPath(base, folder, 'SKILL.md'));
      if (text === null) continue;
      const meta = parseSkillFrontmatter(text);
      const name = meta.name || folder;
      if (seen.has(name)) continue;
      seen.add(name);
      commands.push({ name, description: meta.description ?? '' });
    }
  }
  return commands;
}

/**
 * SKILL.md 开头那段 `---` frontmatter 里的 `name` / `description`(Agent Skills 标准,
 * 官方示例 https://antigravity.google/docs/migration/workflows-to-skills.md)。
 * 认单行标量与 YAML 块标量(`description: |` / `>`,后面缩进的几行)—— owner MBP 的 165 个 skill 里
 * 有好几个是块标量,只认单行时面板上的说明就剩一个「|」「>」(2026-09-24 真机所见)。
 * 块标量折成一行:面板只放得下一行。缺席时回落到文件夹名与空说明。
 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const lines = match[1]!.split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^(name|description)\s*:\s*(.*)$/.exec(lines[index]!);
    if (!field) continue;
    let value = field[2]!.trim();
    if (/^[|>][-+]?$/.test(value)) {
      const block: string[] = [];
      while (index + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[index + 1]!)) {
        index += 1;
        if (lines[index]!.trim()) block.push(lines[index]!.trim());
      }
      value = block.join(' ');
    }
    value = value.replace(/^(['"])(.*)\1$/, '$2');
    if (value) out[field[1] as 'name' | 'description'] = value;
  }
  return out;
}

function joinPath(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/');
}

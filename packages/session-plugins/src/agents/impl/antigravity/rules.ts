import type { AcpCommandDiscoveryContext } from '@gugu/session-core/agents/plugins';

/**
 * Antigravity 的规则文件 → 咕咕读出来,随会话级背景进第一轮(#6335)。
 *
 * ## 为什么要咕咕读
 *
 * `agy_acp_server` 1.2.1 一处规则都不读:8 个位置(`$GEMINI_HOME/GEMINI.md`、`config/GEMINI.md`、
 * `config/rules/`、插件 `rules/AGENTS.md`、工作区 `GEMINI.md` / `AGENTS.md` / `.agents/rules/`)各放一个
 * 标记,发到模型的请求里 0 处(2026-09-24 本地假端点)。而用户写这些文件,是写给 Antigravity 的。
 *
 * ## 读哪几处 —— 照官方文档,一处不多
 *
 *  · 全局:`$GEMINI_HOME/GEMINI.md`(https://antigravity.google/docs/cli/gcli-migration 「Global developer
 *    context … `~/.gemini/GEMINI.md`」)、`$GEMINI_HOME/antigravity-cli/rules/*.md` 与已装插件的
 *    `$GEMINI_HOME/antigravity-cli/plugins/<name>/rules/*.md`(https://antigravity.google/docs/ide/rules
 *    「CLI file locations」)。
 *  · 工作区:`<cwd>/GEMINI.md`、`<cwd>/AGENTS.md`(gcli-migration「Workspace local context」)、
 *    `<cwd>/.agents/rules/*.md`(ide/rules「Workspace rules」)。
 *
 * 规则的 frontmatter `trigger`:缺席或 `always_on` ⇒ 全文带上;其余(`model_decision` / `glob` / `manual`)
 * 只列路径与说明,让模型需要时自己去读 —— 与它「按需激活」的语义同向,❌ 不把按需的规则当常驻塞进去。
 */
const MAX_TOTAL_CHARS = 200_000;

export async function readAntigravityRules(ctx: AcpCommandDiscoveryContext): Promise<string | null> {
  const home = ctx.env.GEMINI_HOME?.trim() || join(ctx.homeDir, '.gemini');
  const candidates: string[] = [join(home, 'GEMINI.md')];
  candidates.push(...(await mdFiles(ctx, join(home, 'antigravity-cli', 'rules'))));
  for (const plugin of (await ctx.fs.listDirs(join(home, 'antigravity-cli', 'plugins'))).sort()) {
    candidates.push(...(await mdFiles(ctx, join(home, 'antigravity-cli', 'plugins', plugin, 'rules'))));
  }
  candidates.push(join(ctx.cwd, 'GEMINI.md'), join(ctx.cwd, 'AGENTS.md'));
  candidates.push(...(await mdFiles(ctx, join(ctx.cwd, '.agents', 'rules'))));

  const alwaysOn: string[] = [];
  const onDemand: string[] = [];
  const seen = new Set<string>();
  let budget = MAX_TOTAL_CHARS;
  for (const path of candidates) {
    const text = await ctx.fs.readText(path);
    if (!text?.trim()) continue;
    const rule = parseRule(text);
    if (!rule.body || seen.has(rule.body)) continue;
    seen.add(rule.body);
    if (rule.trigger && rule.trigger !== 'always_on') {
      const detail = [rule.description, rule.globs ? `applies to ${rule.globs}` : ''].filter(Boolean).join('; ');
      onDemand.push(`- ${path} (${rule.trigger})${detail ? `: ${detail}` : ''}`);
      continue;
    }
    const body = rule.body.length > budget ? `${rule.body.slice(0, budget)}\n[truncated]` : rule.body;
    budget -= body.length;
    alwaysOn.push(`## ${path}\n\n${body}`);
    if (budget <= 0) break;
  }
  if (alwaysOn.length === 0 && onDemand.length === 0) return null;
  return [
    '<user_rules>',
    'The user wrote these Antigravity rule files for you. Follow them.',
    ...alwaysOn,
    ...(onDemand.length ? ['## Rules to read when relevant', ...onDemand] : []),
    '</user_rules>',
  ].join('\n\n');
}

export function parseRule(text: string): { body: string; trigger?: string; description?: string; globs?: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(trigger|description|globs)\s*:\s*(.*)$/.exec(line);
    if (field) meta[field[1]!] = field[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return {
    body: text.slice(match[0].length).trim(),
    ...(meta.trigger ? { trigger: meta.trigger } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.globs ? { globs: meta.globs } : {}),
  };
}

async function mdFiles(ctx: AcpCommandDiscoveryContext, dir: string): Promise<string[]> {
  return (await ctx.fs.listFiles(dir))
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort()
    .map((name) => join(dir, name));
}

function join(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/');
}

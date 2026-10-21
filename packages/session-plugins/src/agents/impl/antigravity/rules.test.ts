import { describe, expect, it } from 'vitest';
import type { AcpCommandDiscoveryContext } from '@gugu/session-core/agents/plugins';
import { parseRule, readAntigravityRules } from './rules';

function ctx(files: Record<string, string>, env: Record<string, string> = {}): AcpCommandDiscoveryContext {
  const children = (dir: string) => Object.keys(files)
    .filter((path) => path.startsWith(`${dir}/`))
    .map((path) => path.slice(dir.length + 1).split('/'));
  return {
    cwd: '/ws',
    env,
    homeDir: '/home/u',
    fs: {
      listDirs: async (dir) => [...new Set(children(dir).filter((p) => p.length > 1).map((p) => p[0]!))],
      listFiles: async (dir) => children(dir).filter((p) => p.length === 1).map((p) => p[0]!),
      readText: async (file) => files[file] ?? null,
    },
  };
}

describe('readAntigravityRules(#6335)', () => {
  it('按官方文档的位置读:全局 → 插件 → 工作区,常驻的全文带上', async () => {
    const text = await readAntigravityRules(ctx({
      '/home/u/.gemini/GEMINI.md': 'global rule',
      '/home/u/.gemini/antigravity-cli/rules/style.md': 'cli rule',
      '/home/u/.gemini/antigravity-cli/plugins/p1/rules/AGENTS.md': 'plugin rule',
      '/ws/GEMINI.md': 'ws gemini',
      '/ws/AGENTS.md': 'ws agents',
      '/ws/.agents/rules/test.md': '---\ntrigger: always_on\n---\nws rule',
    }));
    const order = ['global rule', 'cli rule', 'plugin rule', 'ws gemini', 'ws agents', 'ws rule'].map((t) => text!.indexOf(t));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('## /ws/.agents/rules/test.md');
    expect(text).not.toContain('trigger: always_on');
  });

  it('按需的规则只列路径与说明,不塞全文', async () => {
    const text = await readAntigravityRules(ctx({
      '/ws/.agents/rules/db.md': '---\ntrigger: model_decision\ndescription: when touching migrations\n---\nSECRET BODY',
      '/ws/.agents/rules/css.md': '---\ntrigger: glob\nglobs: "*.css"\n---\nCSS BODY',
    }));
    expect(text).toContain('/ws/.agents/rules/db.md (model_decision): when touching migrations');
    expect(text).toContain('/ws/.agents/rules/css.md (glob): applies to *.css');
    expect(text).not.toContain('SECRET BODY');
    expect(text).not.toContain('CSS BODY');
  });

  it('跟着 GEMINI_HOME 走;同文重复只带一份;一条都没有 ⇒ null', async () => {
    const text = await readAntigravityRules(ctx(
      { '/custom/GEMINI.md': 'same', '/ws/AGENTS.md': 'same' },
      { GEMINI_HOME: '/custom' }
    ));
    expect(text!.split('same').length - 1).toBe(1);
    expect(await readAntigravityRules(ctx({}))).toBeNull();
  });

  it('parseRule 剥掉 frontmatter,认 trigger/description/globs', () => {
    expect(parseRule('---\ntrigger: manual\ndescription: "d"\n---\nbody')).toEqual({
      body: 'body',
      trigger: 'manual',
      description: 'd',
    });
    expect(parseRule('plain')).toEqual({ body: 'plain' });
  });
});

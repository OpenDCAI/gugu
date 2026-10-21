import { describe, expect, it } from 'vitest';
import type { AcpCommandDiscoveryContext } from '@gugu/session-core/agents/plugins';
import { discoverAntigravitySkills, parseSkillFrontmatter } from './skills';

function ctx(files: Record<string, string>, env: Record<string, string> = {}): AcpCommandDiscoveryContext {
  const dirs = (dir: string) =>
    [...new Set(Object.keys(files)
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path) => path.slice(dir.length + 1).split('/')[0]!)
      .filter((name) => Object.keys(files).some((p) => p.startsWith(`${dir}/${name}/`))))];
  return {
    cwd: '/ws',
    env,
    homeDir: '/home/u',
    fs: {
      listDirs: async (dir) => dirs(dir),
      listFiles: async () => [],
      readText: async (file) => files[file] ?? null,
    },
  };
}

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;

describe('discoverAntigravitySkills(#6335)', () => {
  it('扫服务写死的四处,工作区排前、同名以工作区为准', async () => {
    const commands = await discoverAntigravitySkills(ctx({
      '/ws/.agents/skills/deploy/SKILL.md': skill('deploy', 'workspace deploy'),
      '/ws/.gemini/skills/fmt/SKILL.md': skill('fmt', 'format'),
      '/home/u/.gemini/config/skills/deploy/SKILL.md': skill('deploy', 'global deploy'),
      '/home/u/.gemini/config/skills/lint/SKILL.md': skill('lint', 'run lint'),
      '/home/u/.gemini/antigravity-cli/skills/review/SKILL.md': skill('review', 'review it'),
    }));
    expect(commands).toEqual([
      { name: 'deploy', description: 'workspace deploy' },
      { name: 'fmt', description: 'format' },
      { name: 'lint', description: 'run lint' },
      { name: 'review', description: 'review it' },
    ]);
  });

  it('不认的几处不扫 —— 包括 skills.json 里另加的目录', async () => {
    const commands = await discoverAntigravitySkills(ctx({
      '/home/u/.gemini/antigravity-acp/skills/a/SKILL.md': skill('a', 'x'),
      '/home/u/.gemini/antigravity/skills/b/SKILL.md': skill('b', 'y'),
      '/home/u/.gemini/config/skills.json': '{"entries":[{"path":"/extra"}]}',
      '/extra/c/SKILL.md': skill('c', 'z'),
    }));
    expect(commands).toEqual([]);
  });

  it('跟着 GEMINI_HOME 走 —— 用户挪了根或咕咕托管,扫的都是它真在读的那处', async () => {
    const commands = await discoverAntigravitySkills(ctx(
      { '/custom/config/skills/x/SKILL.md': skill('x', 'moved') },
      { GEMINI_HOME: '/custom' }
    ));
    expect(commands).toEqual([{ name: 'x', description: 'moved' }]);
  });

  it('没有 frontmatter 回落文件夹名;没有 SKILL.md 的文件夹不算', async () => {
    const commands = await discoverAntigravitySkills(ctx({
      '/ws/.agents/skills/bare/SKILL.md': '# just text',
      '/ws/.agents/skills/empty/README.md': 'no skill here',
    }));
    expect(commands).toEqual([{ name: 'bare', description: '' }]);
  });

  it('frontmatter 只取单行标量,去引号', () => {
    expect(parseSkillFrontmatter('---\nname: "q"\ndescription: \'d\'\n---\n')).toEqual({ name: 'q', description: 'd' });
    expect(parseSkillFrontmatter('no frontmatter')).toEqual({});
  });

  it('块标量(| 与 >)折成一行 —— 否则面板上只剩一个「|」', () => {
    expect(parseSkillFrontmatter('---\nname: a\ndescription: |\n  line one\n  line two\nother: x\n---\n'))
      .toEqual({ name: 'a', description: 'line one line two' });
    expect(parseSkillFrontmatter('---\ndescription: >-\n  folded\n  text\n---\n'))
      .toEqual({ description: 'folded text' });
  });
});

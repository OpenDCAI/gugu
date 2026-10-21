import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkSkillsJsonRoots, resolveHomePath } from './skills-json';

function skill(dir: string, name: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-skilljson-')));
  const homeDir = join(root, 'user');
  const managed = join(root, 'gugu-home', 'agent-homes', 'antigravity', '.gemini');
  mkdirSync(join(managed, 'config', 'skills'), { recursive: true });
  const extra = join(homeDir, 'extra-skills');
  const shared = join(root, 'shared');
  skill(extra, 'lint');
  skill(extra, 'experimental-x');
  mkdirSync(join(extra, 'not-a-skill'), { recursive: true });
  skill(shared, 'deploy');
  skill(shared, 'secret');
  writeFileSync(join(root, 'shared.json'), JSON.stringify({ entries: [{ path: shared }] }));
  skill(join(managed, 'config', 'skills'), 'lint-copied-earlier');
  return { root, homeDir, managed, extra, shared };
}

describe('linkSkillsJsonRoots(#6335)', () => {
  it('把 skills.json 列出的 skill 链进托管根,按 include_only / exclude / inherits 过滤', async () => {
    const t = setup();
    writeFileSync(join(t.managed, 'config', 'skills.json'), JSON.stringify({
      inherits: [{ path: join(t.root, 'shared.json'), exclude: ['secret'] }],
      entries: [
        { path: '~/extra-skills', exclude: ['experimental-.*'] },
        { path: 'relative/skills' },
      ],
    }));
    const linked = await linkSkillsJsonRoots({ cwd: '/ws', env: { GEMINI_HOME: t.managed }, homeDir: t.homeDir });
    const skills = join(t.managed, 'config', 'skills');
    expect(linked).toBe(2);
    expect(readlinkSync(join(skills, 'lint'))).toBe(join(t.extra, 'lint'));
    expect(readlinkSync(join(skills, 'deploy'))).toBe(join(t.shared, 'deploy'));
    expect(existsSync(join(skills, 'secret'))).toBe(false);
    expect(existsSync(join(skills, 'experimental-x'))).toBe(false);
    expect(existsSync(join(skills, 'not-a-skill'))).toBe(false);
  });

  it('不碰已有的同名条目;源目录删了,只清我们建的那条链接', async () => {
    const t = setup();
    writeFileSync(join(t.managed, 'config', 'skills.json'), JSON.stringify({ entries: [{ path: t.shared }] }));
    skill(join(t.managed, 'config', 'skills'), 'deploy');
    const ctx = { cwd: '/ws', env: { GEMINI_HOME: t.managed }, homeDir: t.homeDir };
    expect(await linkSkillsJsonRoots(ctx)).toBe(1);
    expect(lstatSync(join(t.managed, 'config', 'skills', 'deploy')).isSymbolicLink()).toBe(false);
    rmSync(join(t.shared, 'secret'), { recursive: true });
    await linkSkillsJsonRoots(ctx);
    expect(existsSync(join(t.managed, 'config', 'skills', 'secret'))).toBe(false);
    expect(lstatSync(join(t.managed, 'config', 'skills', 'deploy')).isDirectory()).toBe(true);
  });

  it('GEMINI_HOME 指着用户自己的根 ⇒ 一个字不写', async () => {
    const t = setup();
    const userRoot = join(t.homeDir, '.gemini');
    mkdirSync(join(userRoot, 'config'), { recursive: true });
    writeFileSync(join(userRoot, 'config', 'skills.json'), JSON.stringify({ entries: [{ path: t.shared }] }));
    expect(await linkSkillsJsonRoots({ cwd: '/ws', env: { GEMINI_HOME: userRoot }, homeDir: t.homeDir })).toBe(0);
    expect(await linkSkillsJsonRoots({ cwd: '/ws', env: {}, homeDir: t.homeDir })).toBe(0);
    expect(existsSync(join(userRoot, 'config', 'skills'))).toBe(false);
  });

  it('resolveHomePath 只认绝对路径与 ~/', () => {
    expect(resolveHomePath('~/a', '/h')).toBe('/h/a');
    expect(resolveHomePath('/abs/b', '/h')).toBe('/abs/b');
    expect(resolveHomePath('rel/c', '/h')).toBeNull();
  });
});

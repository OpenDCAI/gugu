import { describe, expect, it } from 'vitest';
import {
  assistantPaths,
  claudeProjectDirName,
  composeInstructions,
  folderNameProblem,
  parseMemoryNote,
  memoryIndexHints,
  parseSkill,
  removeIndexEntry,
  resourceRejection,
  splitInstructions,
  joinPersona,
  splitPersona,
} from './assistant-files';

// 云电脑上真读到的那份(2026-10-15,cloudpc.4)。
const MANAGED = [
  '<!-- 咕咕云电脑:管家维护这一段,改了会被覆盖;写在这段外面的会保留 -->',
  '# 你是谁',
  '你是主人的个人助理。',
  '<!-- /咕咕云电脑 -->',
].join('\n');

describe('说明:管家那段之外才是人能改的', () => {
  it('认得 10-15 起的中性标记(云电脑对用户不可见,标记里不再有「云电脑」)', () => {
    // 管家 core.ts 的 GUIDE_BEGIN / GUIDE_END 原文;测试号 10-15 23:10 醒来后 CLAUDE.md 里就是这一对。
    const managed = ['<!-- 咕咕管家维护这一段,改了会被覆盖;写在这段外面的会保留 -->', '# 你是谁', '你是主人的个人代理。', '<!-- /咕咕管家 -->'].join('\n');
    expect(splitInstructions(`${managed}\n\n# 性格\n温和\n`)).toEqual({ managed, user: '# 性格\n温和' });
    expect(composeInstructions(`${managed}\n\n旧的\n`, '说话直接')).toBe(`${managed}\n\n说话直接\n`);
  });

  it('只有管家那段 = 人写的为空', () => {
    expect(splitInstructions(`${MANAGED}\n`)).toEqual({ managed: MANAGED, user: '' });
  });

  it('前后两截都算人写的', () => {
    const parts = splitInstructions(`开头一句\n\n${MANAGED}\n\n# 性格\n温和`);
    expect(parts.managed).toBe(MANAGED);
    expect(parts.user).toBe('开头一句\n\n# 性格\n温和');
  });

  it('没有管家那段 = 全文都是人写的', () => {
    expect(splitInstructions('  自己写的  \n')).toEqual({ managed: null, user: '自己写的' });
  });

  it('写回时管家那段取此刻文件里的原文,人写的接在后面', () => {
    const upgraded = MANAGED.replace('你是主人的个人助理。', '你是主人的个人助理(新版)。');
    expect(composeInstructions(`${upgraded}\n\n旧的说明\n`, '说话温和一点')).toBe(`${upgraded}\n\n说话温和一点\n`);
  });

  it('留空 = 清掉人写的,管家那段原样留着', () => {
    expect(composeInstructions(`${MANAGED}\n\n旧的说明\n`, '   ')).toBe(`${MANAGED}\n`);
  });

  it('改完再拆,拆出来的正是刚写的(写读往返不丢字)', () => {
    const written = composeInstructions(`${MANAGED}\n`, '# 性格\n先给结论');
    expect(splitInstructions(written)).toEqual({ managed: MANAGED, user: '# 性格\n先给结论' });
  });
});

describe('路径', () => {
  it('Claude Code 的目录名把非字母数字都换成 -', () => {
    expect(claudeProjectDirName('/home/wuying')).toBe('-home-wuying');
    expect(claudeProjectDirName('/Users/a.b/x_y')).toBe('-Users-a-b-x-y');
  });

  it('住云上:记忆、技能、资料各在哪', () => {
    expect(assistantPaths('/home/wuying', '/home/wuying')).toEqual({
      instructions: '/home/wuying/.claude/CLAUDE.md',
      memoryDir: '/home/wuying/.claude/projects/-home-wuying/memory',
      claudeMemoryDir: '/home/wuying/.claude/projects/-home-wuying/memory',
      memoryIndex: '/home/wuying/.claude/projects/-home-wuying/memory/MEMORY.md',
      skillsDir: '/home/wuying/.claude/skills',
      settings: '/home/wuying/.claude/settings.json',
      resourcesDir: '/home/wuying/给助理的资料',
    });
  });

  it('住电脑:都在它的工作目录里(人自己的 ~/.claude 不动)', () => {
    expect(assistantPaths('/Users/me', '/Users/me/.gugu/assistant', 'computer')).toEqual({
      instructions: '/Users/me/.gugu/assistant/CLAUDE.md',
      memoryDir: '/Users/me/.gugu/assistant/.claude/memory',
      claudeMemoryDir: '/Users/me/.claude/projects/-Users-me--gugu-assistant/memory',
      memoryIndex: '/Users/me/.gugu/assistant/.claude/memory/MEMORY.md',
      skillsDir: '/Users/me/.gugu/assistant/.claude/skills',
      settings: '/Users/me/.gugu/assistant/.claude/settings.json',
      resourcesDir: '/Users/me/.gugu/assistant/给助理的资料',
    });
  });
});

describe('记忆', () => {
  it('读 frontmatter 的名字、说明与种类(metadata 下缩进的 type 也认)', () => {
    const note = parseMemoryNote(
      'likes-tea.md',
      '---\nname: 爱喝茶\ndescription: "主人只喝绿茶"\nmetadata:\n  type: user\n---\n\n主人只喝绿茶,不加糖。\n'
    );
    expect(note).toEqual({ file: 'likes-tea.md', title: '爱喝茶', description: '主人只喝绿茶', kind: 'user', body: '主人只喝绿茶,不加糖。' });
  });

  it('missing YAML does not expose an English filename or invent a personal category', () => {
    expect(parseMemoryNote('red-fox.md', '暗号是赤狐九号')).toMatchObject({ title: '记忆', kind: 'reference', body: '暗号是赤狐九号' });
  });

  it('不认得的 type 不冒充四种之一', () => {
    expect(parseMemoryNote('x.md', '---\ntype: diary\n---\nx').kind).toBe('reference');
  });

  it('falls back through a note heading and the actual memory index metadata', () => {
    const hints = memoryIndexHints('# 关于主人\n- [喜欢清淡](likes-tea.md) — 稳定偏好\n# 反馈\n- [少问一次](less-asking.md)\n');
    expect(parseMemoryNote('likes-tea.md', '正文', hints.get('likes-tea.md'))).toMatchObject({ title: '喜欢清淡', kind: 'user' });
    expect(parseMemoryNote('less-asking.md', '# 自主推进\n正文', hints.get('less-asking.md'))).toMatchObject({ title: '自主推进', kind: 'feedback' });
    expect(parseMemoryNote('english.md', '---\ntitle: 中文标题\ncategory: 项目\n---\n正文')).toMatchObject({ title: '中文标题', kind: 'project' });
  });

  it('删记忆时索引里指向它的那一行一起拿掉,别的行不动', () => {
    const index = '- [暗号](red-fox.md) — 有人来问就说\n- [爱喝茶](likes-tea.md) — 绿茶\n';
    expect(removeIndexEntry(index, 'red-fox.md')).toBe('- [爱喝茶](likes-tea.md) — 绿茶\n');
    expect(removeIndexEntry(index, 'nope.md')).toBe(index);
  });
});

describe('技能', () => {
  it('名字与说明来自 SKILL.md,缺名字用夹名', () => {
    expect(parseSkill('weekly', '---\nname: 周报\ndescription: 每周五汇总\n---\n步骤……')).toEqual({ dir: 'weekly', name: '周报', description: '每周五汇总', body: '步骤……' });
    expect(parseSkill('weekly', '没有头')).toMatchObject({ name: 'weekly', description: '' });
  });
});

describe('上传与命名规矩', () => {
  it('50MB 以上、视频音频压缩包不收', () => {
    expect(resourceRejection({ name: 'a.pdf', size: 1024 })).toBeNull();
    expect(resourceRejection({ name: 'a.pdf', size: 51 * 1024 * 1024 })).toBe('too_large');
    expect(resourceRejection({ name: 'clip.MP4', size: 10 })).toBe('unsupported');
    expect(resourceRejection({ name: 'voice', size: 10, type: 'audio/mpeg' })).toBe('unsupported');
    expect(resourceRejection({ name: 'x.zip', size: 10 })).toBe('unsupported');
  });

  it('文件夹名不能空、不能带 /', () => {
    expect(folderNameProblem('  ')).toBe('required');
    expect(folderNameProblem('a/b')).toBe('slash');
    expect(folderNameProblem('工作')).toBeNull();
  });
});

describe('personality', () => {
  it('reads the preset line and the description back from what it wrote', () => {
    const text = joinPersona('warm', '多关心我一点');
    expect(text).toBe('性格：温暖\n多关心我一点');
    expect(splitPersona(text)).toEqual({ preset: 'warm', rest: '多关心我一点' });
    expect(splitPersona(joinPersona('sassy', ''))).toEqual({ preset: 'sassy', rest: '' });
  });

  it('leaves text without a preset line as the description, and an unknown word is not a preset', () => {
    expect(splitPersona('说话简短')).toEqual({ preset: null, rest: '说话简短' });
    expect(splitPersona('性格：古怪\n别的')).toEqual({ preset: null, rest: '性格：古怪\n别的' });
    expect(joinPersona(null, '  只写描述 ')).toBe('只写描述');
  });
});

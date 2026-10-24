// #7199 个人助理的家(云上那台,或人自己的一台电脑;位置见 assistantHomePaths),这一页读写的几样东西在那台机器上都是文件(下面按云上那一份说):
//   说明 / 性格 = ~/.claude/CLAUDE.md 里管家那段之外的部分(管家那段每次开通 / 升级都会被它整段覆盖);
//   记忆 = Claude Code 给这个工作目录记的那一夹(~/.claude/projects/<目录名>/memory/,MEMORY.md 是索引);
//   技能 = ~/.claude/skills/<名字>/SKILL.md(自己做的那些);
//   给它的资料 = 主目录下一个文件夹,人放进去,再叫助理去看。
// 这里只放纯解析与拼装(可单测),读写在 assistant-machine.ts。
import {
  ASSISTANT_RESOURCES_DIR_NAME,
  assistantHomePaths,
  type AssistantHomeKind,
  type AssistantHomePaths,
} from '@gugu/core/shared/assistantPolicy';

/**
 * 管家维护的那一段的头尾(开通、每次唤醒写进 CLAUDE.md,见管家的「助理」那一步)。
 * 10-15 起是中性标记(云电脑对用户不可见,助理读到标记也不该学会「云电脑」这个词);
 * 早先开通、还没醒过的机器上可能还是旧的那一对,两对都认。
 */
export const MANAGED_BLOCK_MARKERS: ReadonlyArray<{ start: string; end: string }> = [
  { start: '<!-- 咕咕管家', end: '<!-- /咕咕管家 -->' },
  { start: '<!-- 咕咕云电脑', end: '<!-- /咕咕云电脑 -->' },
];

export type InstructionsParts = {
  /** 管家那一段原文(连头尾标记);文件里没有 = null。 */
  managed: string | null;
  /** 管家那段之外人写的,前后两截合成一段。 */
  user: string;
};

export function splitInstructions(text: string): InstructionsParts {
  for (const marker of MANAGED_BLOCK_MARKERS) {
    const start = text.indexOf(marker.start);
    const endAt = start < 0 ? -1 : text.indexOf(marker.end, start);
    if (start >= 0 && endAt >= 0) return splitAt(text, start, endAt + marker.end.length);
  }
  return { managed: null, user: text.trim() };
}

function splitAt(text: string, start: number, end: number): InstructionsParts {
  const user = [text.slice(0, start), text.slice(end)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
  return { managed: text.slice(start, end), user };
}

/**
 * 人改完「说明」要写回去的全文:管家那段照**此刻文件里的原文**留在最前面(❌ 用打开编辑框时读到的那份 —— 中间管家可能刚升级过),
 * 人写的接在后面。人写的清空 = 只剩管家那段(「留空可清除」)。
 */
export function composeInstructions(current: string, userText: string): string {
  const { managed } = splitInstructions(current);
  const body = userText.trim();
  if (!managed) return body ? `${body}\n` : '';
  return body ? `${managed}\n\n${body}\n` : `${managed}\n`;
}

export { claudeProjectDirName } from '@gugu/core/shared/assistantPolicy';

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export type AssistantPaths = AssistantHomePaths;

/** 人放给助理看的资料放在这一夹(「添加与你有关的文件」)。 */
export const RESOURCES_DIR_NAME = ASSISTANT_RESOURCES_DIR_NAME;

/** 它家里那几样在哪(住云上 / 住电脑位置不同,见 @gugu/core/shared/assistantPolicy 的 assistantHomePaths)。 */
export function assistantPaths(home: string, projectPath: string, kind: AssistantHomeKind = 'cloud'): AssistantPaths {
  return assistantHomePaths(home, projectPath, kind);
}

/** 文件开头 `---` 之间那几行里的简单键值(name / description / type,也认 metadata 下缩进的 type)。 */
export function readFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { fields: {}, body: normalized.trim() };
  const close = normalized.indexOf('\n---', 4);
  if (close < 0) return { fields: {}, body: normalized.trim() };
  const fields: Record<string, string> = {};
  for (const line of normalized.slice(4, close).split('\n')) {
    const match = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    const value = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value && !(key in fields)) fields[key] = value;
  }
  const after = normalized.slice(close + 4);
  return { fields, body: after.replace(/^[^\n]*\n/, '').trim() };
}

/** Claude Code 的记忆分四种;「关于你 / 关于助理」对应前两种。 */
export type MemoryKind = 'user' | 'feedback' | 'project' | 'reference' | 'other';

export type MemoryNote = {
  file: string;
  title: string;
  description: string;
  kind: MemoryKind;
  body: string;
};

const MEMORY_KINDS: readonly MemoryKind[] = ['user', 'feedback', 'project', 'reference'];
const memoryKind = (value: string | undefined): MemoryKind | undefined => {
  const aliases: Record<string, MemoryKind> = { 用户: 'user', 关于主人: 'user', 偏好: 'user', 反馈: 'feedback', 关于助理: 'feedback', 项目: 'project', 参考: 'reference', 资料: 'reference' };
  return MEMORY_KINDS.find(kind => kind === value?.toLowerCase()) ?? aliases[value ?? ''];
};

/** Legacy memories often put their readable name/category in the index instead of YAML. */
export function memoryIndexHints(index: string): Map<string, { title: string; kind?: MemoryKind }> {
  const result = new Map<string, { title: string; kind?: MemoryKind }>();
  let kind: MemoryKind | undefined;
  for (const line of index.split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) kind = memoryKind(heading[1].trim());
    const link = /\[([^\]]+)\]\((?:\.\/)?([^\s)]+\.md)\)/.exec(line);
    if (link && !link[2].includes('/')) result.set(link[2], { title: link[1], ...(kind ? { kind } : {}) });
  }
  return result;
}

export function parseMemoryNote(file: string, text: string, hint?: { title: string; kind?: MemoryKind }): MemoryNote {
  const { fields, body } = readFrontmatter(text);
  // Missing metadata is a reference, not an invented claim about the person.
  const kind = memoryKind(fields.type) ?? memoryKind(fields.category) ?? hint?.kind ?? 'reference';
  const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(body)?.[1];
  const filename = file.replace(/\.md$/i, '');
  return {
    file,
    title: fields.title || fields.name || heading || hint?.title || (/\p{Script=Han}/u.test(filename) ? filename : '记忆'),
    description: fields.description ?? '',
    kind,
    body,
  };
}

/** 删一条记忆时把索引里指向它的那一行一起拿掉(否则 MEMORY.md 里留一条指向空处的链接)。 */
export function removeIndexEntry(index: string, file: string): string {
  const target = `](${file})`;
  return index
    .split('\n')
    .filter((line) => !line.includes(target))
    .join('\n');
}

export type SkillInfo = {
  /** 技能所在的那一夹名字(删除、编辑都按它)。 */
  dir: string;
  name: string;
  description: string;
  body: string;
};

export function parseSkill(dir: string, text: string): SkillInfo {
  const { fields, body } = readFrontmatter(text);
  return { dir, name: fields.name || dir, description: fields.description ?? '', body };
}

/** 上传规矩:单个文件 50MB 以内;视频、音频、压缩包不收(助理读不了)。 */
export const RESOURCE_MAX_BYTES = 50 * 1024 * 1024;
const REJECTED_EXTENSIONS = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|mp3|wav|m4a|aac|flac|ogg|opus|zip|rar|7z|tar|gz|tgz|bz2|xz)$/i;

export type ResourceRejection = 'too_large' | 'unsupported';

export function resourceRejection(file: { name: string; size: number; type?: string }): ResourceRejection | null {
  if (file.size > RESOURCE_MAX_BYTES) return 'too_large';
  const type = file.type ?? '';
  if (REJECTED_EXTENSIONS.test(file.name) || type.startsWith('video/') || type.startsWith('audio/')) return 'unsupported';
  return null;
}

/** 名字只能是一段(新建文件夹、重命名):非空、不含 `/`。 */
export function folderNameProblem(name: string): 'required' | 'slash' | null {
  if (!name.trim()) return 'required';
  if (name.includes('/')) return 'slash';
  return null;
}

/**
 * 性格(`character`:balanced / warm / direct / concise / playful / sassy 六选一 + 一段自由描述)。
 * 写进说明里人写的那部分,第一行 `性格：<词>`(给它读的是中文词,不随界面语言变),其余是描述。
 */
export const PERSONA_PRESETS = ['balanced', 'warm', 'direct', 'concise', 'playful', 'sassy'] as const;
export type PersonaPreset = (typeof PERSONA_PRESETS)[number];
const PERSONA_WORDS: Record<PersonaPreset, string> = {
  balanced: '均衡',
  warm: '温暖',
  direct: '直接',
  concise: '简洁',
  playful: '活泼',
  sassy: '毒舌',
};
const PERSONA_PREFIX = '性格：';

export function splitPersona(user: string): { preset: PersonaPreset | null; rest: string } {
  const text = user.replace(/\r\n/g, '\n');
  const newline = text.indexOf('\n');
  const first = (newline < 0 ? text : text.slice(0, newline)).trim();
  if (!first.startsWith(PERSONA_PREFIX)) return { preset: null, rest: text.trim() };
  const word = first.slice(PERSONA_PREFIX.length).trim();
  const preset = PERSONA_PRESETS.find((key) => PERSONA_WORDS[key] === word) ?? null;
  if (!preset) return { preset: null, rest: text.trim() };
  return { preset, rest: newline < 0 ? '' : text.slice(newline + 1).trim() };
}

export function joinPersona(preset: PersonaPreset | null, rest: string): string {
  const body = rest.trim();
  if (!preset) return body;
  const line = `${PERSONA_PREFIX}${PERSONA_WORDS[preset]}`;
  return body ? `${line}\n${body}` : line;
}

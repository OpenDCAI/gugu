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

export { MANAGED_BLOCK_MARKERS, splitInstructions, composeInstructions } from '@gugu/core/shared/assistantInstructions';
export type { InstructionsParts } from '@gugu/core/shared/assistantInstructions';

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

import { readFrontmatter } from '@gugu/core/shared/assistantMemory';
export { readFrontmatter,parseMemoryNote,memoryIndexHints,removeIndexEntry,isOwnerProfileNote } from '@gugu/core/shared/assistantMemory';
export type { MemoryNote,MemoryKind } from '@gugu/core/shared/assistantMemory';

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

import { OWNER_PROFILE_MEMORY_FILE } from './assistantPolicy';
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

/**
 * 开通时写进记忆夹的那一条(owner-profile.md)。文件里叫「关于主人」,那是写给助理自己读的名字;
 * 界面上对人一律叫「关于你」(owner 10-26:「我叫主人别人可能不叫主人」),❌ 把「主人」「用户」原样摆给人看。
 */
export function isOwnerProfileNote(note: { file: string }): boolean {
  return note.file === OWNER_PROFILE_MEMORY_FILE;
}

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


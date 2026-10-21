import { humanId } from 'human-id';

const MAX_SESSION_NAME_LENGTH = 64;

function sanitize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SESSION_NAME_LENGTH);
}

export function generateRandom(): string {
  return sanitize(humanId({ separator: '-', capitalize: false }));
}

// nbranch 按需加载:它带着 compromise(英文 NLP 库,词典在 import 时解压成大对象,主进程堆 +8 MB),
// 而这里只在「按标题起分支名」时才用。本模块被任务/自动化等启动路径静态 import,❌ 顶层 import 它。
async function generateFromInput(title: string, description?: string): Promise<string> {
  const { generateBranchName } = await import('nbranch');
  const input = description ? `${title}\n\n${description}` : title;
  const raw = generateBranchName(input, {
    addRandomSuffix: false,
    separator: '-',
    maxLength: MAX_SESSION_NAME_LENGTH,
  });
  return sanitize(raw);
}

export async function generateSessionName(params: {
  title?: string;
  description?: string;
}): Promise<string> {
  const { title, description } = params;
  if (title && title.trim().length > 0) {
    return await generateFromInput(title.trim(), description?.trim());
  }
  return generateRandom();
}

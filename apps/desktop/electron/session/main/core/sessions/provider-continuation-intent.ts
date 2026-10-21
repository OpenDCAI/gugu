import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '@main/lib/logger';
import { claudeTranscriptDirFor } from './fork-lineage';

const INTENT_DIRECTORY = '.gugu-continuations';

export type ProviderContinuationIntent = {
  version: 1;
  kind: 'provider-continuation';
  sessionId: string;
  sourceProviderSessionId: string;
  startedAt: string;
  continuationProviderSessionId?: string;
};

function assertId(value: string, field: string): void {
  if (!value || value.includes('/') || value.includes('\\')) {
    throw new Error(`invalid provider continuation ${field}`);
  }
}

function intentDirectoryFor(sessionPath: string): string {
  return path.join(claudeTranscriptDirFor(sessionPath), INTENT_DIRECTORY);
}

function intentPathFor(sessionPath: string, sessionId: string): string {
  assertId(sessionId, 'sessionId');
  return path.join(intentDirectoryFor(sessionPath), `${sessionId}.json`);
}

function parseIntent(raw: string, filePath: string): ProviderContinuationIntent {
  const value = JSON.parse(raw) as Partial<ProviderContinuationIntent>;
  if (
    value.version !== 1 ||
    value.kind !== 'provider-continuation' ||
    typeof value.sessionId !== 'string' ||
    typeof value.sourceProviderSessionId !== 'string' ||
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    (value.continuationProviderSessionId !== undefined && typeof value.continuationProviderSessionId !== 'string')
  ) {
    throw new Error(`invalid provider continuation intent: ${filePath}`);
  }
  assertId(value.sessionId, 'sessionId');
  assertId(value.sourceProviderSessionId, 'sourceSessionId');
  if (value.continuationProviderSessionId) assertId(value.continuationProviderSessionId, 'continuationSessionId');
  return value as ProviderContinuationIntent;
}

async function writeIntent(sessionPath: string, intent: ProviderContinuationIntent): Promise<void> {
  const directory = intentDirectoryFor(sessionPath);
  await mkdir(directory, { recursive: true });
  const destination = intentPathFor(sessionPath, intent.sessionId);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(intent)}\n`, 'utf8');
  await rename(temporary, destination);
  // @@@3890⑭ 发布成功后顺手收掉**这个目标名**下别人留下的半成品。写入本身已是 tmp+rename(所以 `.json`
  // 永远不会半截),但进程死在 writeFile 与 rename 之间会留下一个 `<conv>.json.<uuid>.tmp` —— 它不匹配
  // `.json` 后缀,不会毒到读侧,却永远没人删:每崩一次多一个,而这个目录随 task worktree 一直存在。
  // 不给它配 TTL / 启动清扫器(那是给不该存在的对象配保姆):同一个 conversation 下一次成功发布就把它带走,
  // 回收由正常写路径驱动、范围只限本目标名。❌ 别改用固定 tmp 名来「结构上避免」——同 conversation 的并发
  // 写会互相踩进对方的半成品,拿一个真损坏换一个垃圾文件。
  await removeStaleTemporaries(directory, path.basename(destination), path.basename(temporary));
}

/** 清掉 `<destination>.<uuid>.tmp` 形状的历史半成品;刚刚用过的那个已被 rename 带走,跳过。 */
async function removeStaleTemporaries(
  directory: string,
  destinationName: string,
  justUsed: string
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter(
        (name) =>
          name !== justUsed && name.startsWith(`${destinationName}.`) && name.endsWith('.tmp')
      )
      .map((name) => rm(path.join(directory, name), { force: true }).catch(() => undefined))
  );
}

export async function recordProviderContinuationIntent(input: {
  sessionPath: string;
  sessionId: string;
  sourceProviderSessionId: string;
}): Promise<void> {
  const sessionPath = await realpath(input.sessionPath);
  await writeIntent(sessionPath, {
    version: 1,
    kind: 'provider-continuation',
    sessionId: input.sessionId,
    sourceProviderSessionId: input.sourceProviderSessionId,
    startedAt: new Date().toISOString(),
  });
}

export async function listProviderContinuationIntents(
  sessionPath: string
): Promise<ProviderContinuationIntent[]> {
  const directory = intentDirectoryFor(sessionPath);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // @@@3890⑭ 逐个解析,坏的一个只丢它自己。原来是 `Promise.all(map(parseIntent))`:任意一个文件解析不过
  // 就让整趟 listProviderContinuationIntents 抛,而它是 fork-capture 绑定 provider continuation 的唯一入口
  // —— 一个坏文件就废掉整个 task 的全部续接绑定(包括那些完好的),且 append-only 目录里没人会去修它。
  // 「跳过坏的」严格优于「全丢」:丢一条 vs 丢全部,而且响亮记账、不静默。
  const intents = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const filePath = path.join(directory, name);
        try {
          return parseIntent(await readFile(filePath, 'utf8'), filePath);
        } catch (error) {
          log.error('providerContinuation: skipping unreadable intent file', {
            filePath,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      })
  );
  return intents.filter((intent): intent is ProviderContinuationIntent => intent !== null);
}

export async function completeProviderContinuationIntent(
  sessionPath: string,
  intent: ProviderContinuationIntent,
  continuationProviderSessionId: string
): Promise<void> {
  assertId(continuationProviderSessionId, 'continuationSessionId');
  await writeIntent(sessionPath, { ...intent, continuationProviderSessionId });
}

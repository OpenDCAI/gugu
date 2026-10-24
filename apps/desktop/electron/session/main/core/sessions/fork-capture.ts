import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { nativeHomeRoots } from '@gugu/session-core/agents/plugins/helpers';
import { requireNativeHome } from '@gugu/session-plugins/agents';
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions, workspaces } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { sessionCreatedChannel } from '@shared/core/sessions/sessionEvents';
import { MAX_SESSION_TITLE_LENGTH } from '@shared/core/sessions/sessions';
import { sessionWorkspaceManager } from './session-workspace-manager';
import { buildSessionRow } from './build-session-row';
import { sessionBorn } from './session-born';
import {
  claudeTranscriptDirFor,
  listProviderSessionTranscriptFiles,
  pickForkParent,
  readTranscriptHead,
  readTranscriptUuids,
  TranscriptAnchorIndex,
  type SessionTranscriptFile,
  type SessionTranscriptHead,
} from './fork-lineage';
import {
  completeProviderContinuationIntent,
  listProviderContinuationIntents,
} from './provider-continuation-intent';
import { readRuntimeForkOwnership } from './runtime-fork-ownership';
import { isObservedCodexFork } from './codex-fork-observer';
import { setProviderSessionId } from './set-session-id';
import { isRetiredRemoteWorkspace } from '@main/core/workspaces/resolve-workspace-kind';

type SessionRow = typeof sessions.$inferSelect;

const SCAN_MIN_INTERVAL_MS = 5_000;
const lastScanAt = new Map<string, number>();
const inFlight = new Set<string>();
const recurringScans = new Map<string, NodeJS.Timeout>();
const codexTranscriptCache = new Map<string, CodexForkTranscript | null>();
/**
 * 每份 Claude 记录的开头只读一次:第一条消息与 forkedFrom 一经写下就不会再变。没有它,每 5 秒
 * 一趟就得把同目录的全部记录重读一遍 —— 那正是 #5459 里 Beta 主进程常年 83% CPU 的来源
 * (真实目录实测:每趟每任务 ~1 秒 CPU、147.7 MB)。
 */
const claudeTranscriptHeads = new Map<string, SessionTranscriptHead>();
/** 在管会话记录的锚(开头 + 各压缩点),增量读:之后每趟只读追加的字节。 */
const managedTranscriptAnchors = new TranscriptAnchorIndex();
/**
 * 一台常用机上 `~/.codex/sessions` 有几万个 rollout(d15 实测 34,877 个 / 1.9 GB)。原本
 * `Promise.all` 一口气全打开、每个先分配 128 KB 缓冲 → 4.4 GB 同时压在堆上,会话页宿主 /
 * 主进程直接 OOM 自杀,重启后客户端一重连又来一遍(#4994 第二根因)。现在:同时最多开这么多
 * 个文件;每个只按小块读到首行结束(上限照旧 128 KB),读完即释放。
 */
const CODEX_SCAN_CONCURRENCY = 16;
const CODEX_FIRST_LINE_CHUNK_BYTES = 16 * 1024;
const CODEX_FIRST_LINE_MAX_BYTES = 128 * 1024;
const CONTINUATION_MATCH_WINDOW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

// In-app-deleted sessions whose transcripts still exist on disk must not resurrect as
// "external forks". In-memory only for v1: after an app restart a deleted fork whose
// transcript survives can reappear once (delete it again, or remove the transcript).
const tombstonedProviderSessionIds = new Set<string>();

/** Called by deleteSession so the capture scan never re-registers a deleted session. */
export function tombstoneDeletedSession(providerSessionIds: Array<string | null | undefined>): void {
  for (const providerSessionId of providerSessionIds) {
    if (providerSessionId) tombstonedProviderSessionIds.add(providerSessionId);
  }
}

/**
 * spec session-fork-share:用户在 TUI 里(claude `/fork` 复制成后台会话、`/branch`、
 * `--resume <源> --fork-session`,codex `/fork`)fork 出的会话不走咕咕的路,咕咕只能轮询发现。
 * 轮询按会话:一趟只盯**这一条、未归档**的会话,只列文件名,只有「首条消息对得上它」的新记录才算候选;与它无关的记录(同目录下
 * 别的会话、别的咕咕实例的会话)读一次开头就再也不碰。同目录里咕咕**自己管着**的别的会话(产品分叉就住在那儿,#6269)
 * 算「已知」、也进候选池认父亲,但登记归父亲那一条的那一趟。
 */
export function scheduleExternalForkCapture(projectId: string, sessionId: string): void {
  const key = `${projectId}:${sessionId}`;
  const now = Date.now();
  if (inFlight.has(key)) return;
  const last = lastScanAt.get(key);
  if (last !== undefined && now - last < SCAN_MIN_INTERVAL_MS) return;
  lastScanAt.set(key, now);
  inFlight.add(key);
  void captureExternalForks(projectId, sessionId)
    .catch((error) => {
      log.warn('forkCapture: scan failed', { projectId, error: String(error) });
    })
    .finally(() => {
      inFlight.delete(key);
    });
}

type CodexForkTranscript = {
  providerSessionId: string;
  parentProviderSessionId: string;
  cwd: string;
  mtimeMs: number;
};

async function listJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listJsonlFiles(filePath);
      return entry.isFile() && entry.name.endsWith('.jsonl') ? [filePath] : [];
    })
  );
  return nested.flat();
}

/** UUIDv7 的前 48 位是毫秒时间戳(codex 的会话 id 是 v7);别的版本取不到出生时刻,返回 null。 */
function uuidV7Timestamp(id: string): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  return Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);
}

/**
 * fork 一定晚于它的源会话出生,而 codex 按「年/月/日」分目录存 rollout ⇒ 只列最早那条在管会话
 * 出生那天到今天的目录(两头各放一天,抵掉 codex 按本地时区分日)。有在管会话的 id 不是 v7
 * (老版本 codex)时退回列整棵树。
 */
async function listCodexRolloutsSince(
  sessionsRoot: string,
  parentProviderSessionIds: string[]
): Promise<string[]> {
  const births = parentProviderSessionIds.map(uuidV7Timestamp);
  if (births.length === 0 || births.some((birth) => birth === null)) {
    return listJsonlFiles(sessionsRoot);
  }
  const first = Math.min(...(births as number[])) - DAY_MS;
  const last = Date.now() + DAY_MS;
  const dayDirs: string[] = [];
  for (let day = first - (first % DAY_MS); day <= last; day += DAY_MS) {
    const date = new Date(day);
    dayDirs.push(
      path.join(
        sessionsRoot,
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0')
      )
    );
  }
  return (await Promise.all(dayDirs.map(listJsonlFiles))).flat();
}

/** 只读首行:分块推进,见到换行就停;超过上限就把已读的当首行(与从前 128 KB 一刀切同口径)。 */
async function readFirstLine(handle: FileHandle): Promise<string> {
  const chunk = Buffer.alloc(CODEX_FIRST_LINE_CHUNK_BYTES);
  const parts: Buffer[] = [];
  let position = 0;
  while (position < CODEX_FIRST_LINE_MAX_BYTES) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    const read = chunk.subarray(0, bytesRead);
    const newline = read.indexOf(0x0a);
    if (newline !== -1) {
      parts.push(Buffer.from(read.subarray(0, newline)));
      break;
    }
    parts.push(Buffer.from(read));
    position += bytesRead;
  }
  return Buffer.concat(parts).toString('utf8').trim();
}

async function readCodexForkTranscript(filePath: string): Promise<CodexForkTranscript | null> {
  const handle = await open(filePath, 'r');
  try {
    const firstLine = await readFirstLine(handle);
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as {
      type?: unknown;
      payload?: { id?: unknown; session_id?: unknown; forked_from_id?: unknown; cwd?: unknown };
    };
    if (parsed.type !== 'session_meta') return null;
    const providerSessionId = parsed.payload?.session_id ?? parsed.payload?.id;
    const parentProviderSessionId = parsed.payload?.forked_from_id;
    const cwd = parsed.payload?.cwd;
    if (
      typeof providerSessionId !== 'string' ||
      typeof parentProviderSessionId !== 'string' ||
      typeof cwd !== 'string'
    ) {
      return null;
    }
    return { providerSessionId, parentProviderSessionId, cwd, mtimeMs: (await stat(filePath)).mtimeMs };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  } finally {
    await handle.close();
  }
}

async function captureCodexForks(
  projectId: string,
  workspaceId: string,
  sessionPath: string,
  rows: SessionRow[],
  knownProviderSessionIds: Set<string>,
  unclaimedForkSourceIds: Set<string>,
  env: NodeJS.ProcessEnv
): Promise<void> {
  // 出生时 sessionId = 行 id 的会话还没拿到 codex 线程 id,不可能已经被 fork。
  const managedCodexThreadIds = rows
    .filter((row) => row.provider === 'codex' && row.providerSessionId && row.providerSessionId !== row.id)
    .map((row) => row.providerSessionId!);
  if (managedCodexThreadIds.length === 0) return;

  // codex 现在写 rollout 的那一份配置根 = 候选的第一个。
  const [codexHome] = nativeHomeRoots(requireNativeHome('codex'), env, homedir());
  const files = await listCodexRolloutsSince(
    path.join(codexHome, 'sessions'),
    managedCodexThreadIds
  );
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CODEX_SCAN_CONCURRENCY, files.length) }, async () => {
      while (cursor < files.length) {
        const filePath = files[cursor++]!;
        if (!codexTranscriptCache.has(filePath)) {
          codexTranscriptCache.set(filePath, await readCodexForkTranscript(filePath));
        }
      }
    })
  );
  const transcripts = files
    .map((filePath) => codexTranscriptCache.get(filePath))
    .filter((value): value is CodexForkTranscript => value !== null && value !== undefined);
  transcripts.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const rowByProviderSessionId = new Map<string, SessionRow>();
  for (const row of rows) rowByProviderSessionId.set(row.providerSessionId ?? row.id, row);

  for (const transcript of transcripts) {
    if (knownProviderSessionIds.has(transcript.providerSessionId)) continue;
    // A live app-server client may still be deciding whether this child is the visible TUI's
    // rewind branch. Do not materialize it in the sidebar during that handoff window.
    if (isObservedCodexFork(transcript.providerSessionId)) continue;
    const parent = rowByProviderSessionId.get(transcript.parentProviderSessionId);
    if (!parent || parent.provider !== 'codex') continue;
    const transcriptPath = await realpath(transcript.cwd).catch(() => transcript.cwd);
    if (transcriptPath !== sessionPath) continue;
    // 这条 rollout 的来源会话上还挂着一条待认领的产品 fork ⇒ 它可能正是那条 fork 的 child,
    // 归属未定,留到下一趟(认领落定后它要么已知、要么才算真外部)。
    if (unclaimedForkSourceIds.has(parent.id)) continue;
    const parentConfig = parent.config?.type === 'pty' ? parent.config : undefined;
    const [inserted] = await db
      .insert(sessions)
      .values({
        ...buildSessionRow({
          id: randomUUID(),
          projectId,
          workspaceId,
          title: `${parent.title}-fork`.slice(0, MAX_SESSION_TITLE_LENGTH),
          // 分叉名是谱系标记:harness 照抄来源的名盖上来,两行会同名 —— 当显式命名处理。
          titleSource: 'manual',
          provider: 'codex',
          runtime: 'pty',
          origin: { kind: 'fork', forkedFrom: { sessionId: parent.id, title: parent.title } },
          // 分叉照抄源会话的权限档、模型和推理档(同 fork-session.ts):缺了档位,只读的源会被补成「编辑」。
          permissionMode: parentConfig?.permissionMode,
          model: parentConfig?.model,
          effort: parentConfig?.effort,
          claimsFirstSpawn: false,
        }),
        // 外面开出来的分叉:引擎的会话已经在了,id 是它自己的,时间是它最后一次写记录的时刻。
        providerSessionId: transcript.providerSessionId,
        lastInteractedAt: new Date(transcript.mtimeMs).toISOString(),
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) continue;
    rows.push(inserted);
    knownProviderSessionIds.add(transcript.providerSessionId);
    rowByProviderSessionId.set(transcript.providerSessionId, inserted);
    const session = sessionBorn(inserted, 'forkCapture');
    events.emit(sessionCreatedChannel, { session });
  }
}

/**
 * 本任务的 Claude 会话记录所在的目录。`/fork` 出的副本在 git 仓库里改文件前会搬进自己的 worktree
 * (`<任务目录>/.claude/worktrees/<名字>`),claude 随之把整份记录挪到那个 worktree 的记录目录
 * (claude 2.1.266 实测)—— 只看任务目录那一个就会漏掉它。从任务目录 `--resume` 仍接得上它。
 */
async function listSessionTranscriptFiles(sessionPath: string, env: NodeJS.ProcessEnv): Promise<SessionTranscriptFile[]> {
  const dirs = [claudeTranscriptDirFor(sessionPath, env)];
  const worktreesRoot = path.join(sessionPath, '.claude', 'worktrees');
  let entries: Dirent[];
  try {
    entries = await readdir(worktreesRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktree = path.join(worktreesRoot, entry.name);
    dirs.push(claudeTranscriptDirFor(await realpath(worktree).catch(() => worktree), env));
  }
  const byProviderSessionId = new Map<string, SessionTranscriptFile>();
  for (const files of await Promise.all(dirs.map(listProviderSessionTranscriptFiles))) {
    for (const file of files) {
      if (!byProviderSessionId.has(file.providerSessionId)) byProviderSessionId.set(file.providerSessionId, file);
    }
  }
  return [...byProviderSessionId.values()];
}

async function claudeTranscriptHeadOf(filePath: string): Promise<SessionTranscriptHead | null> {
  const remembered = claudeTranscriptHeads.get(filePath);
  if (remembered) return remembered;
  const head = await readTranscriptHead(filePath);
  if (head) claudeTranscriptHeads.set(filePath, head);
  return head;
}

async function mtimeOf(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * spec session-graph:产品自己 fork 出的会话,在 provider 铸出 child id 之前就已经是那条 transcript
 * 的主人 —— 但它还**叫不出那个名字**。additive fork(claude `--resume <源> --fork-session`)不带
 * `--session-id`(plugin 的 `sessionIdOnFork: false`),child id 由 claude 在 init 时铸;而 claude 装
 * 的钩子只有 UserPromptSubmit / Notification / Stop,**没有 SessionStart** ⇒ 咕咕要等这条 fork 的
 * 第一句话才拿到那个 id。claude 恰恰也在同一刻才写下 child transcript ⇒ 5 秒一趟的扫描能正好落在
 * 两者之间,把产品自己的 fork 当成外部 fork 又登记一遍。
 *
 * 待认领状态不必另存一份:产品早就把这条 fork 落成了自己的会话行,那行自己就作得了证 —— pty 会话
 * 出生时 `sessionId = id`(build-session-row 的 `sessionIdAtBirth`),而 provider 铸的 child id
 * 永远不会等于行 id ⇒ **`sessionId === id` 的 fork 行 = 已经起了一条 fork、还没认领它的 provider
 * 会话**。这段时间里,谱系父亲是它来源会话的未知 transcript 归属未定,按 spec「无法证明归属时留在
 * 产品外」留到下一趟。❌ 不用时间窗:fork 与它的第一句之间可以隔任意久。
 *
 * ACP 分叉是同一个形状,只是「还没认领」写法不同:ACP 会话出生时 `sessionId = null`,`session/fork`
 * 拿回新 id 之后才写进来 —— 而 claude ACP 适配器写 transcript 与咕咕落这一格之间同样有空档
 * (#6269 实测:forkedSessionId 返回后约 1 秒,一趟扫描把它登记成了来源的外部 fork)。
 */
function unclaimedProductForkSourceIds(rows: SessionRow[]): Set<string> {
  const sources = new Set<string>();
  for (const row of rows) {
    const forkedFrom = row.config?.forkedFrom?.sessionId;
    if (!forkedFrom) continue;
    const unclaimed = row.runtime === 'acp' ? row.providerSessionId === null : row.providerSessionId === row.id;
    if (!unclaimed) continue;
    sources.add(forkedFrom);
  }
  return sources;
}

/**
 * 把扫描认出来的 provider 会话 id 落到会话行上 —— 经 {@link setSessionId},所以渲染端也会收到。
 *
 * 写不进去不拖垮整趟扫描(会话可能刚被删),但**要响亮记一笔**:悄悄跳过的话,那条会话会一直
 * 停在绑定之前的 id 上,而日志里没有任何东西说得出为什么。
 */
async function bindProviderSessionId(sessionId: string, providerSessionId: string): Promise<void> {
  const result = await setProviderSessionId(sessionId, providerSessionId);
  if (!result.success) {
    log.warn('forkCapture: could not bind the provider session id', {
      sessionId,
      error: result.error.type,
    });
  }
}

async function bindProviderContinuations(
  projectId: string,
  sessionPath: string,
  rows: SessionRow[],
  files: SessionTranscriptFile[],
  knownProviderSessionIds: Set<string>
): Promise<void> {
  const intents = await listProviderContinuationIntents(sessionPath);
  const fileByProviderSessionId = new Map(files.map((file) => [file.providerSessionId, file]));

  for (const intent of intents) {
    const row = rows.find(
      (candidate) => candidate.id === intent.sessionId && candidate.provider === 'claude'
    );
    if (!row) continue;

    knownProviderSessionIds.add(intent.sourceProviderSessionId);
    if (intent.continuationProviderSessionId) {
      knownProviderSessionIds.add(intent.continuationProviderSessionId);
      if (row.providerSessionId !== intent.continuationProviderSessionId) {
        // 经 setSessionId 写 —— 它会把这一格广播给活着的渲染进程。❌ 别退回裸 `db.update`:
        // 续接绑定发生在后台扫描里,用户看不见;不说一声,渲染端就会一直拿着绑定**之前**的那个 id
        // (#5869 里那条「写口有四个、只有一个会说话」正是这么攒出来的)。
        await bindProviderSessionId(row.id, intent.continuationProviderSessionId);
        row.providerSessionId = intent.continuationProviderSessionId;
      }
      continue;
    }

    const source = fileByProviderSessionId.get(intent.sourceProviderSessionId);
    const sourceAnchors = source ? await managedTranscriptAnchors.anchorsOf(source.filePath) : null;
    if (!sourceAnchors || sourceAnchors.size === 0) continue;
    // 续接出来的新记录抄的是源会话的消息 ⇒ 首条消息落在源会话的锚里;对不上的一概不看。
    const startedAt = Date.parse(intent.startedAt);
    let continuation: { providerSessionId: string; mtimeMs: number } | undefined;
    for (const file of files) {
      if (file.providerSessionId === intent.sourceProviderSessionId || knownProviderSessionIds.has(file.providerSessionId)) continue;
      const head = await claudeTranscriptHeadOf(file.filePath);
      if (!head || !sourceAnchors.has(head.rootUuid)) continue;
      const mtimeMs = await mtimeOf(file.filePath);
      if (mtimeMs === null) continue;
      if (mtimeMs < startedAt || mtimeMs > startedAt + CONTINUATION_MATCH_WINDOW_MS) continue;
      if (!continuation || mtimeMs < continuation.mtimeMs) {
        continuation = { providerSessionId: file.providerSessionId, mtimeMs };
      }
    }
    if (!continuation) continue;

    // 同上:写这一格就得说一声(理由见上面那处)。
    await bindProviderSessionId(row.id, continuation.providerSessionId);
    row.providerSessionId = continuation.providerSessionId;
    knownProviderSessionIds.add(continuation.providerSessionId);
    await completeProviderContinuationIntent(sessionPath, intent, continuation.providerSessionId);
    log.info('forkCapture: bound provider continuation to existing session', {
      projectId,
      sessionId: row.id,
      sourceProviderSessionId: intent.sourceProviderSessionId,
      continuationProviderSessionId: continuation.providerSessionId,
    });
  }
}

/** 谱系候选:在管会话,以及本趟刚登记 / 推迟的 fork。 */
type LineageCandidate = {
  sessionId: string;
  providerSessionId: string;
  title: string;
  lastInteractedAt: string | null;
  filePath: string;
  /** 开头 + 各压缩点的 uuid;fork 的首条消息落在父亲的锚里。 */
  anchors: Set<string>;
};

type NewTranscript = SessionTranscriptFile & { head: SessionTranscriptHead; mtimeMs: number };

async function resolveForkParent(
  transcript: NewTranscript,
  pool: LineageCandidate[]
): Promise<LineageCandidate | null> {
  const declared = transcript.head.forkedFromProviderSessionId;
  if (declared) {
    const direct = pool.find((candidate) => candidate.providerSessionId === declared);
    if (direct) return direct;
  }
  const sameRoot = pool.filter((candidate) => candidate.anchors.has(transcript.head.rootUuid));
  if (sameRoot.length <= 1) return sameRoot[0] ?? null;
  // 同一条谱系上有好几代(P→X→Y):直接父亲与新记录重叠最多。只在新 fork 出现的这一刻、只读这几条。
  const childUuids = await readTranscriptUuids(transcript.filePath);
  const ranked = await Promise.all(
    sameRoot.map(async (candidate) => ({
      sessionId: candidate.sessionId,
      title: candidate.title,
      lastInteractedAt: candidate.lastInteractedAt,
      uuids: await readTranscriptUuids(candidate.filePath),
    }))
  );
  const best = pickForkParent(childUuids, ranked);
  return best ? (sameRoot.find((c) => c.sessionId === best.sessionId) ?? null) : null;
}

export async function captureExternalForks(projectId: string, sessionId: string): Promise<void> {
  const [workspace] = await db
    .select({
      id: workspaces.id,
      path: workspaces.path,
      type: workspaces.type,
      location: workspaces.location,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!workspace?.path || isRetiredRemoteWorkspace(workspace)) return;

  // Claude slugs its transcript dir from the session cwd AFTER resolving symlinks — on
  // macOS a /tmp/... workspace records under /private/tmp/... (verified live). Canonicalize
  // before slugging or the scan reads an empty dir and silently finds nothing.
  const workspacePath = workspace.path;
  const sessionPath = await realpath(workspacePath).catch(() => workspacePath);

  // 「这条记录咕咕认不认识」按**整个项目**问,「谁能当父亲」只看这一条。两件事的范围不同:
  // 产品分叉是独立会话、与来源共用工作目录(#6269)⇒ 两边的记录在同一个目录里、还共享开头;
  // 只拿这一条当「已知」,来源那一趟会把分叉的记录当成外部 fork 再登记一遍,分叉那一趟
  // 又会把来源的记录认成自己的 fork。咕咕管着的任何会话,都不是「外部」。
  const projectRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.projectId, projectId));

  const knownProviderSessionIds = new Set<string>(tombstonedProviderSessionIds);
  for (const row of projectRows) {
    knownProviderSessionIds.add(row.id);
    if (row.providerSessionId) knownProviderSessionIds.add(row.providerSessionId);
    // Reserved before copying begins: a maintenance branch is never an external task.
    if (row.config?.type === 'acp') for (const branch of row.config.assistantContextBranches ?? []) knownProviderSessionIds.add(branch);
  }
  // spec session-graph:归档只问会话自己那一列。已归档的会话仍算「已知」—— 它的记录不许被当成新 fork
  // 再登记一遍 —— 但不再监测它派生出的 fork。
  const managed = projectRows.filter((row) => row.id === sessionId && !row.archivedAt);
  if (managed.length === 0) return;
  const owner = managed[0]!;
  if (owner.provider !== 'claude' && owner.provider !== 'codex') return;
  // 两家的会话都跑在用户自己的配置根上(#26),记录也在那里,换了默认订阅也不挪。
  const transcriptEnv = process.env;
  // 运行时自己 fork 出、只活在运行时里的会话(#4236)不进侧栏 —— 这一条的、同目录别的会话的都一样。
  // ❌ 以前遇到「别的会话的」就抛错:而一个工作目录挂多条会话是常态,于是每一趟都在半路
  // 抛错退出,外部 fork 永远认领不到(正式版日志每小时 1400+ 条 `forkCapture: scan failed`)。
  for (const runtimeFork of await readRuntimeForkOwnership(process.env)) {
    knownProviderSessionIds.add(runtimeFork.providerSessionId);
    knownProviderSessionIds.add(runtimeFork.runtimeSessionId);
  }

  // 待认领的产品分叉是别的会话(#6269),它的来源却是这一条 —— 所以也按整个项目找。
  const unclaimedForkSourceIds = unclaimedProductForkSourceIds(projectRows);

  await captureCodexForks(
    projectId,
    workspace.id,
    sessionPath,
    managed,
    knownProviderSessionIds,
    unclaimedForkSourceIds,
    transcriptEnv
  );

  if (!managed.some((row) => row.provider === 'claude')) return;
  const files = await listSessionTranscriptFiles(sessionPath, transcriptEnv);
  await bindProviderContinuations(projectId, sessionPath, managed, files, knownProviderSessionIds);

  const fileByProviderSessionId = new Map(files.map((file) => [file.providerSessionId, file]));
  // 候选父亲 = 这个目录里咕咕在管的**全部**会话,不只这一条:产品分叉是独立会话、与来源同目录
  // (#6269),在分叉的终端里再 `/fork` 一次,真父亲是那条分叉 —— 候选池里没有它,这一趟就会把孙子
  // 错认成来源的儿子,而 config.forkedFrom 一经写下就是永久的。父亲认准之后**由父亲那一条的那一趟登记**,
  // 别的会话只让它进池(好让它的后代也认对父亲),不替人落行。
  const lineageRows = projectRows.filter((row) => !row.archivedAt);
  const foreignLineageIds = new Set(
    lineageRows.filter((row) => row.id !== sessionId).map((row) => row.id)
  );
  const pool: LineageCandidate[] = [];
  for (const row of lineageRows) {
    if (row.provider !== 'claude') continue;
    const providerSessionId = row.providerSessionId ?? row.id;
    const file = fileByProviderSessionId.get(providerSessionId);
    if (!file) continue;
    const anchors = await managedTranscriptAnchors.anchorsOf(file.filePath);
    if (anchors.size === 0) continue;
    pool.push({
      sessionId: row.id,
      providerSessionId,
      title: row.title,
      lastInteractedAt: row.lastInteractedAt,
      filePath: file.filePath,
      anchors,
    });
  }
  if (pool.length === 0) return;
  const managedAnchors = new Set(pool.flatMap((candidate) => [...candidate.anchors]));
  const managedProviderSessionIds = new Set(pool.map((candidate) => candidate.providerSessionId));

  const fresh: NewTranscript[] = [];
  for (const file of files) {
    if (knownProviderSessionIds.has(file.providerSessionId)) continue;
    const head = await claudeTranscriptHeadOf(file.filePath);
    if (!head) continue;
    const related =
      managedAnchors.has(head.rootUuid) ||
      (head.forkedFromProviderSessionId !== null && managedProviderSessionIds.has(head.forkedFromProviderSessionId));
    if (!related) continue;
    const mtimeMs = await mtimeOf(file.filePath);
    if (mtimeMs === null) continue;
    fresh.push({ ...file, head, mtimeMs });
  }
  if (fresh.length === 0) return;

  // Chained external forks (P→X→Y discovered in one sweep) must see X as a candidate when
  // Y is resolved, or Y binds to P. Process oldest-first and feed each captured fork back
  // into the pool. Residual: if X was used again after Y was forked, X's mtime can sort it
  // after Y and Y still resolves to its grandparent.
  fresh.sort((a, b) => a.mtimeMs - b.mtimeMs);
  // 待认领的产品 fork 会遮住一整条谱系,不只遮一个 transcript:被推迟的那条自己也进候选池,
  // 于是「被推迟者的后代」会挑中它而不是错认成祖父 —— 错认写进 config.forkedFrom 是永久的。
  const unclaimedLineageIds = new Set(unclaimedForkSourceIds);
  for (const transcript of fresh) {
    const parent = await resolveForkParent(transcript, pool);
    if (!parent) continue;
    const lastInteractedAt = new Date(transcript.mtimeMs).toISOString();
    const deferredLineage = unclaimedLineageIds.has(parent.sessionId)
      ? unclaimedLineageIds
      : foreignLineageIds.has(parent.sessionId)
        ? foreignLineageIds
        : null;
    if (deferredLineage) {
      pool.push({
        sessionId: transcript.providerSessionId,
        providerSessionId: transcript.providerSessionId,
        title: '',
        lastInteractedAt,
        filePath: transcript.filePath,
        anchors: await managedTranscriptAnchors.anchorsOf(transcript.filePath),
      });
      deferredLineage.add(transcript.providerSessionId);
      continue;
    }

    const parentRow = managed.find((row) => row.id === parent.sessionId);
    const parentConfig = parentRow?.config?.type === 'pty' ? parentRow.config : undefined;
    const [inserted] = await db
      .insert(sessions)
      .values({
        ...buildSessionRow({
          // The external session id is a UUID; using it as the conversation id keeps the
          // claude invariant (conversation.id == session id), so opening the row resumes it.
          id: transcript.providerSessionId,
          projectId,
          workspaceId: workspace.id,
          title: `${parent.title}-fork`.slice(0, MAX_SESSION_TITLE_LENGTH),
          titleSource: 'manual',
          provider: 'claude',
          runtime: 'pty',
          origin: { kind: 'fork', forkedFrom: { sessionId: parent.sessionId, title: parent.title } },
          // 分叉照抄源会话的权限档(同 fork-session.ts):缺了它,只读的源会被补成「编辑」。
          permissionMode: parentConfig?.permissionMode,
          model: parentConfig?.model,
          claimsFirstSpawn: false,
        }),
        providerSessionId: transcript.providerSessionId,
        lastInteractedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) continue; // raced with a concurrent registration

    managed.push(inserted);
    pool.push({
      sessionId: inserted.id,
      providerSessionId: transcript.providerSessionId,
      title: inserted.title,
      lastInteractedAt: inserted.lastInteractedAt,
      filePath: transcript.filePath,
      anchors: await managedTranscriptAnchors.anchorsOf(transcript.filePath),
    });

    const session = sessionBorn(inserted, 'forkCapture');
    events.emit(sessionCreatedChannel, { session });
    log.info('forkCapture: registered external fork', {
      projectId,
      providerSessionId: transcript.providerSessionId,
      forkedFrom: parent.sessionId,
    });
  }
}

// External forks happen while a session is open in some terminal — sweep on mount, when
// the workspace (and its transcript dir) is actually resolvable. The list-RPC trigger alone
// misses the common boot path where sidebar conversations arrive preloaded in bulk and
// getUnarchivedSession never fires (verified live: boot → zero scans).
sessionWorkspaceManager.hooks.on('session:provisioned', ({ projectId, sessionId }) => {
  scheduleExternalForkCapture(projectId, sessionId);
  const key = `${projectId}:${sessionId}`;
  if (recurringScans.has(key)) return;
  const timer = setInterval(() => scheduleExternalForkCapture(projectId, sessionId), 5_000);
  timer.unref();
  recurringScans.set(key, timer);
});

sessionWorkspaceManager.hooks.on('session:torn-down', ({ projectId, sessionId }) => {
  const key = `${projectId}:${sessionId}`;
  const timer = recurringScans.get(key);
  if (timer) clearInterval(timer);
  recurringScans.delete(key);
  lastScanAt.delete(key);
});

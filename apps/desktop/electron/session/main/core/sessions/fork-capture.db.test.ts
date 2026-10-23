import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { captureExternalForks } from './fork-capture';
import { claudeTranscriptDirFor } from './fork-lineage';
import {
  listProviderContinuationIntents,
  recordProviderContinuationIntent,
} from './provider-continuation-intent';
import { recordRuntimeForkOwnership } from './runtime-fork-ownership';
import { observeCodexFork, settleCodexForkObservation } from './codex-fork-observer';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));
// 统计同时打开的文件句柄峰值:几万个 codex rollout 一口气全开就是 #4994 的第二根因。
const openGauge = vi.hoisted(() => ({ inFlight: 0, peak: 0, opened: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      openGauge.inFlight += 1;
      openGauge.opened += 1;
      openGauge.peak = Math.max(openGauge.peak, openGauge.inFlight);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        openGauge.inFlight -= 1;
        return close();
      };
      return handle;
    },
  };
});

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

// session-workspace-manager registers a `session:provisioned` hook at module load.
vi.mock('./session-workspace-manager', () => ({
  sessionWorkspaceManager: {
    hooks: { on: vi.fn() },
  },
}));

vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('./session-events', () => ({ sessionEvents: { _emit: vi.fn() } }));

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const GRANDCHILD = '33333333-3333-4333-8333-333333333333';

/** A forked transcript carries a copy of its ancestors' uuids plus its own new lines. */
function jsonl(uuids: string[]): string {
  return uuids.map((uuid) => JSON.stringify({ type: 'user', uuid })).join('\n');
}

function forkedFromId(row: { config?: unknown } | undefined): string | undefined {
  const config = row?.config as { type?: string; forkedFrom?: { sessionId?: string } } | null;
  return config && config.type === 'pty' ? config.forkedFrom?.sessionId : undefined;
}

describe('captureExternalForks — chained external forks in one sweep', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let workspace: string;
  let configDir: string;
  const projectId = 'project-1';

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    workspace = await mkdtemp(path.join(tmpdir(), 'fork-capture-ws-'));
    configDir = await mkdtemp(path.join(tmpdir(), 'fork-capture-cfg-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.CODEX_HOME = path.join(configDir, 'codex');
    process.env.GUGU_HOME = configDir;

    fixture.sqlite
      .prepare(
        `INSERT INTO projects (id, name, path, created_at, updated_at)
         VALUES (?, 'Project', '/repo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run(projectId);
    fixture.sqlite
      .prepare(
        `INSERT INTO workspaces (id, type, kind, location, path, created_at, updated_at)
         VALUES ('workspace-1', 'local', 'worktree', 'local', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run(workspace);

    // The one registered claude conversation — the root of the fork chain.
    await fixture.db.insert(sessions).values({
      id: PARENT,
      projectId,
      workspaceId: 'workspace-1',
      title: '母会话',
      provider: 'claude',
      config: { version: '1', type: 'pty' },
      providerSessionId: PARENT,
      runtime: 'pty',
      lastInteractedAt: '2026-07-01T00:00:00.000Z',
    });

    // Transcripts on disk: parent, a fork of parent, and a fork of that fork. Both forks are
    // unregistered ("unknown") so they surface in the same sweep. mtimes ascending so the
    // capture processes the child before the grandchild.
    const dir = claudeTranscriptDirFor(await realpath(workspace));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${PARENT}.jsonl`), jsonl(['p1', 'p2']));
    await writeFile(path.join(dir, `${CHILD}.jsonl`), jsonl(['p1', 'p2', 'x1']));
    await writeFile(path.join(dir, `${GRANDCHILD}.jsonl`), jsonl(['p1', 'p2', 'x1', 'y1']));
    await utimes(path.join(dir, `${PARENT}.jsonl`), new Date('2026-07-01'), new Date('2026-07-01'));
    await utimes(path.join(dir, `${CHILD}.jsonl`), new Date('2026-07-02'), new Date('2026-07-02'));
    await utimes(
      path.join(dir, `${GRANDCHILD}.jsonl`),
      new Date('2026-07-03'),
      new Date('2026-07-03')
    );
  });

  afterEach(async () => {
    fixture.close();
    mocks.db = undefined;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    delete process.env.GUGU_HOME;
    await rm(workspace, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  it('binds the grandchild to the child captured in the same sweep, not the grandparent', async () => {
    await captureExternalForks(projectId, PARENT);

    const rows = await fixture.db.select().from(sessions);
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.has(CHILD)).toBe(true);
    expect(byId.has(GRANDCHILD)).toBe(true);
    // Child forks directly from the registered parent.
    expect(forkedFromId(byId.get(CHILD))).toBe(PARENT);
    // Grandchild's largest uuid overlap is with the child — which only becomes a candidate
    // because the sweep feeds each just-inserted fork back into the candidate pool. Without
    // that, the grandchild would mis-bind to the grandparent.
    expect(forkedFromId(byId.get(GRANDCHILD))).toBe(CHILD);
  });

  it('carries the source session\'s permission mode onto captured forks, so a read-only source stays read-only', async () => {
    await fixture.db.update(sessions)
      .set({ config: { version: '1', type: 'pty', permissionMode: 'read-only' } })
      .where(eq(sessions.id, PARENT));
    await captureExternalForks(projectId, PARENT);

    const rows = await fixture.db.select().from(sessions);
    const child = rows.find((row) => row.id === CHILD);
    expect(child?.config).toMatchObject({ permissionMode: 'read-only' });
  });

  it('binds a marked provider continuation to its existing row instead of inserting a fork', async () => {
    const sessionPath = await realpath(workspace);
    const transcriptDir = claudeTranscriptDirFor(sessionPath);
    await rm(path.join(transcriptDir, `${GRANDCHILD}.jsonl`), { force: true });
    await recordProviderContinuationIntent({
      sessionPath,
      sessionId: PARENT,
      sourceProviderSessionId: PARENT,
    });
    const afterIntent = new Date(Date.now() + 1_000);
    await utimes(path.join(transcriptDir, `${CHILD}.jsonl`), afterIntent, afterIntent);

    await captureExternalForks(projectId, PARENT);

    const rows = await fixture.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(PARENT);
    expect(rows[0]?.providerSessionId).toBe(CHILD);
    const [intent] = await listProviderContinuationIntents(sessionPath);
    expect(intent?.continuationProviderSessionId).toBe(CHILD);

    await captureExternalForks(projectId, PARENT);
    expect(await fixture.db.select().from(sessions)).toHaveLength(1);
  });

  it('leaves the child minted by a product fork spawn to that fork row, then releases once claimed', async () => {
    // 产品里点一次「Fork conversation」:fork 住进**自己的新任务**(#6269),与来源共用同一行 workspace,
    // 先落一条自己的会话行(pty fork 出生时 sessionId = id),再 spawn `claude --resume <PARENT> --fork-session`。
    // claude 自己铸 child id,而咕咕要等这条 fork 的第一句话(UserPromptSubmit 钩子)才拿到它 ——
    // CHILD.jsonl 就是那一刻写下的 transcript。
    const FORK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await fixture.db.insert(sessions).values({
      id: FORK,
      projectId,
      workspaceId: 'workspace-1',
      title: '母会话-fork',
      provider: 'claude',
      config: {
        version: '1',
        type: 'pty',
        forkedFrom: { sessionId: PARENT, title: '母会话' },
      },
      providerSessionId: FORK,
      runtime: 'pty',
      lastInteractedAt: '2026-07-02T00:00:00.000Z',
    });
    const sweepBoth = async () => {
      await captureExternalForks(projectId, PARENT);
      await captureExternalForks(projectId, FORK);
    };

    await sweepBoth();

    // 归属未定的这一趟:CHILD 是那条 fork 还没认领的 provider 会话,GRANDCHILD 又是 CHILD 的后代 ——
    // 两条都不该被登记成外部 fork(多出来的行不继承会话级平台配置,打开就是 model restore 警告)。
    // 两个任务各扫一趟:来源任务看不见 fork 行也得认出这是它的待认领 fork;fork 任务不许把来源的
    // transcript(开头与自己相同)认成自己的 fork。
    const pending = await fixture.db.select().from(sessions);
    expect(pending.map((row) => row.id).sort()).toEqual([FORK, PARENT].sort());

    // 钩子落定:fork 行认领了 claude 铸的 CHILD。遮挡随之解除。
    await fixture.db
      .update(sessions)
      .set({ providerSessionId: CHILD })
      .where(eq(sessions.id, FORK));

    // 只扫来源任务:GRANDCHILD 的父亲是 fork 行,住在别的任务 ⇒ 来源这一趟不替它落行,更不许错认成
    // 来源的儿子(候选池里若没有 fork 行,唯一同根的就是 PARENT)。
    await captureExternalForks(projectId, PARENT);
    expect((await fixture.db.select().from(sessions)).map((row) => row.id).sort()).toEqual(
      [FORK, PARENT].sort()
    );

    await sweepBoth();

    // 阳性对照 —— 判据不是「什么都不登记」:CHILD 现在已知(归 fork 行),而 GRANDCHILD 是一条
    // 真的外部 fork,必须照旧被捕获,认 fork 行做父亲而不是祖父,并落在父亲的工作区。
    const claimed = await fixture.db.select().from(sessions);
    expect(claimed.map((row) => row.id).sort()).toEqual([FORK, GRANDCHILD, PARENT].sort());
    const grandchild = claimed.find((row) => row.id === GRANDCHILD);
    expect(forkedFromId(grandchild)).toBe(FORK);
    expect(grandchild?.workspaceId).toBe('workspace-1');
  });

  it('leaves an ACP product fork\'s freshly forked session to that row until it is claimed', async () => {
    // ACP 分叉:行出生时 sessionId = null,`session/fork` 拿回的新 id(CHILD)要稍后才写进来;
    // claude 适配器在那之前就写下了 CHILD.jsonl。这一格空档里的扫描不许把它当外部 fork。
    await rm(path.join(claudeTranscriptDirFor(await realpath(workspace)), `${GRANDCHILD}.jsonl`), { force: true });
    const FORK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await fixture.db.insert(sessions).values({
      id: FORK,
      projectId,
      workspaceId: 'workspace-1',
      title: '母会话-fork',
      provider: 'claude',
      config: {
        version: '1',
        type: 'acp',
        forkedFrom: { sessionId: PARENT, title: '母会话' },
        forkFromProviderSessionId: PARENT,
      },
      providerSessionId: null,
      runtime: 'acp',
      lastInteractedAt: '2026-07-02T00:00:00.000Z',
    });

    await captureExternalForks(projectId, PARENT);
    expect((await fixture.db.select().from(sessions)).map((row) => row.id).sort()).toEqual(
      [FORK, PARENT].sort()
    );

    // 认领落定之后 CHILD 已知 —— 仍然不登记,而且不是因为扫描停了:见上一条用例的阳性对照。
    await fixture.db.update(sessions).set({ providerSessionId: CHILD }).where(eq(sessions.id, FORK));
    await captureExternalForks(projectId, PARENT);
    expect((await fixture.db.select().from(sessions)).map((row) => row.id).sort()).toEqual(
      [FORK, PARENT].sort()
    );
  });

  it('does not capture a marked runtime-only fork, while an unmarked fork remains visible', async () => {
    await recordRuntimeForkOwnership({
      runtimeSessionId: 'runtime-view-1',
      sourceSessionId: PARENT,
      provider: 'claude',
      providerSessionId: CHILD,
      workspaceId: 'workspace-1',
      cwd: await realpath(workspace),
    }, { GUGU_HOME: configDir });

    await captureExternalForks(projectId, PARENT);
    const rows = await fixture.db.select().from(sessions);
    expect(rows.some((row) => row.id === CHILD)).toBe(false);
    expect(rows.some((row) => row.id === GRANDCHILD)).toBe(true);
  });

  it('captures a Codex /fork rollout by its structured forked_from_id', async () => {
    const codexParentId = '44444444-4444-4444-8444-444444444444';
    const codexChildId = '55555555-5555-4555-8555-555555555555';
    await fixture.db.insert(sessions).values({
      id: '66666666-6666-4666-8666-666666666666',
      projectId,
      workspaceId: 'workspace-1',
      title: 'Codex 母会话',
      provider: 'codex',
      config: { version: '1', type: 'pty', model: 'gpt-test', permissionMode: 'read-only' },
      providerSessionId: codexParentId,
      runtime: 'pty',
      lastInteractedAt: '2026-07-04T00:00:00.000Z',
    });
    const sessionDir = path.join(process.env.CODEX_HOME!, 'sessions', '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, `rollout-test-${codexChildId}.jsonl`),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: codexChildId,
          session_id: codexChildId,
          forked_from_id: codexParentId,
          cwd: await realpath(workspace),
        },
      })}\n${JSON.stringify({ type: 'response_item', payload: { text: 'inherited' } })}`
    );

    observeCodexFork(codexChildId, codexParentId);
    await captureExternalForks(projectId, '66666666-6666-4666-8666-666666666666');

    expect(
      (await fixture.db.select().from(sessions)).some((row) => row.providerSessionId === codexChildId),
    ).toBe(false);

    // An explicit `/fork` is not adopted by the live TUI session, so the normal scanner
    // must regain ownership after the classification window closes.
    settleCodexForkObservation(codexChildId, false);
    await captureExternalForks(projectId, '66666666-6666-4666-8666-666666666666');

    const rows = await fixture.db.select().from(sessions);
    const child = rows.find((row) => row.providerSessionId === codexChildId);
    expect(child).toBeDefined();
    expect(child?.id).not.toBe(codexChildId);
    expect(child?.provider).toBe('codex');
    expect(forkedFromId(child)).toBe('66666666-6666-4666-8666-666666666666');
    expect(child?.config).toMatchObject({ permissionMode: 'read-only' });
  });

  it('scans a large Codex session tree with bounded open handles, still finding the fork', async () => {
    const codexParentId = '77777777-7777-4777-8777-777777777777';
    const codexChildId = '88888888-8888-4888-8888-888888888888';
    await fixture.db.insert(sessions).values({
      id: '99999999-9999-4999-8999-999999999999',
      projectId,
      workspaceId: 'workspace-1',
      title: 'Codex 母会话',
      provider: 'codex',
      config: { version: '1', type: 'pty', model: 'gpt-test' },
      providerSessionId: codexParentId,
      runtime: 'pty',
      lastInteractedAt: '2026-07-04T00:00:00.000Z',
    });
    const cwd = await realpath(workspace);
    // 200 个无关 rollout 摊在几个日期目录里,外加一个真正的 /fork 子会话藏在中间。
    const total = 200;
    for (let index = 0; index < total; index += 1) {
      const sessionDir = path.join(process.env.CODEX_HOME!, 'sessions', '2026', '08', String(index % 7).padStart(2, '0'));
      await mkdir(sessionDir, { recursive: true });
      const id = index === 101 ? codexChildId : `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;
      const payload = index === 101
        ? { id, session_id: id, forked_from_id: codexParentId, cwd }
        : { id, session_id: id, cwd };
      await writeFile(
        path.join(sessionDir, `rollout-bulk-${id}.jsonl`),
        `${JSON.stringify({ type: 'session_meta', payload })}\n${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(4096) } })}\n`
      );
    }
    openGauge.inFlight = 0;
    openGauge.peak = 0;
    openGauge.opened = 0;

    await captureExternalForks(projectId, '99999999-9999-4999-8999-999999999999');

    // 阳性对照:确实逐个打开过(否则「峰值很低」只是因为没扫)。
    expect(openGauge.opened).toBeGreaterThanOrEqual(total);
    expect(openGauge.peak).toBeLessThanOrEqual(16);
    const rows = await fixture.db.select().from(sessions);
    const child = rows.find((row) => row.providerSessionId === codexChildId);
    expect(forkedFromId(child)).toBe('99999999-9999-4999-8999-999999999999');
  });
  it('keeps sweeping past a runtime-only fork owned by another task on the same workspace', async () => {
    await recordRuntimeForkOwnership({
      runtimeSessionId: 'runtime-view-other',
      sourceSessionId: 'other-conversation',
      provider: 'claude',
      providerSessionId: CHILD,
      workspaceId: 'workspace-1',
      cwd: await realpath(workspace),
    }, { GUGU_HOME: configDir });

    await expect(captureExternalForks(projectId, PARENT)).resolves.toBeUndefined();
    const rows = await fixture.db.select().from(sessions);
    expect(rows.some((row) => row.id === CHILD)).toBe(false);
    expect(rows.some((row) => row.id === GRANDCHILD)).toBe(true);
  });

  it('stops watching an archived session, without re-registering its transcript as a fork', async () => {
    // 归档只问会话自己那一列;任务被归档时它名下的会话一并盖章。
    fixture.sqlite
      .prepare(`UPDATE sessions SET archived_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(PARENT);

    await captureExternalForks(projectId, PARENT);

    const rows = await fixture.db.select().from(sessions);
    expect(rows.map((row) => row.id)).toEqual([PARENT]);
  });

  it('binds an SDK fork to the source it declares', async () => {
    const SDK_FORK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const dir = claudeTranscriptDirFor(await realpath(workspace));
    await writeFile(
      path.join(dir, `${SDK_FORK}.jsonl`),
      JSON.stringify({ type: 'attachment', uuid: 'sdk-1', forkedFrom: { sessionId: PARENT } })
    );

    await captureExternalForks(projectId, PARENT);

    const rows = await fixture.db.select().from(sessions);
    expect(forkedFromId(rows.find((row) => row.id === SDK_FORK))).toBe(PARENT);
  });

  it('lists only the Codex day directories since the managed session was born', async () => {
    const bornAt = Date.now() - 2 * 86_400_000;
    const hex = bornAt.toString(16).padStart(12, '0');
    const codexParentId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8abc-0123456789ab`;
    const codexChildId = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
    await fixture.db.insert(sessions).values({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      projectId,
      workspaceId: 'workspace-1',
      title: 'Codex 母会话',
      provider: 'codex',
      config: { version: '1', type: 'pty', model: 'gpt-test' },
      providerSessionId: codexParentId,
      runtime: 'pty',
      lastInteractedAt: new Date(bornAt).toISOString(),
    });
    const cwd = await realpath(workspace);
    const dayDir = (at: number) => {
      const date = new Date(at);
      return path.join(
        process.env.CODEX_HOME!,
        'sessions',
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0')
      );
    };
    // 源会话出生前很久的 rollout:fork 不可能落在那里,不该被打开。
    const oldDir = dayDir(bornAt - 30 * 86_400_000);
    await mkdir(oldDir, { recursive: true });
    await writeFile(
      path.join(oldDir, 'rollout-old.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'old', session_id: 'old', cwd } })}\n`
    );
    const todayDir = dayDir(Date.now());
    await mkdir(todayDir, { recursive: true });
    await writeFile(
      path.join(todayDir, `rollout-${codexChildId}.jsonl`),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: codexChildId, session_id: codexChildId, forked_from_id: codexParentId, cwd },
      })}\n`
    );
    openGauge.opened = 0;

    await captureExternalForks(projectId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

    expect(openGauge.opened).toBe(1);
    const rows = await fixture.db.select().from(sessions);
    expect(forkedFromId(rows.find((row) => row.providerSessionId === codexChildId))).toBe(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    );
  });
  it('captures a /fork copy whose transcript moved into its own worktree', async () => {
    // claude `/fork` 的副本在 git 仓库里改文件前会搬进 `<任务目录>/.claude/worktrees/<名字>`,
    // 整份记录随之挪到那个 worktree 的记录目录(claude 2.1.266 实测)。
    const FORK_COPY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const sessionPath = await realpath(workspace);
    await rm(path.join(claudeTranscriptDirFor(sessionPath), `${CHILD}.jsonl`), { force: true });
    await rm(path.join(claudeTranscriptDirFor(sessionPath), `${GRANDCHILD}.jsonl`), { force: true });
    const worktree = path.join(sessionPath, '.claude', 'worktrees', 'my-task');
    await mkdir(worktree, { recursive: true });
    const worktreeTranscripts = claudeTranscriptDirFor(await realpath(worktree));
    await mkdir(worktreeTranscripts, { recursive: true });
    await writeFile(path.join(worktreeTranscripts, `${FORK_COPY}.jsonl`), jsonl(['p1', 'p2', 'w1']));

    await captureExternalForks(projectId, PARENT);

    const rows = await fixture.db.select().from(sessions);
    expect(forkedFromId(rows.find((row) => row.id === FORK_COPY))).toBe(PARENT);
  });
  it('captures a fork of a compacted session, whose copy starts at the compact boundary', async () => {
    // claude 2.1.266 实测:会话压缩过之后,`--fork-session` 的副本从源会话最近的压缩点抄起,
    // 首条消息不再是源会话的开头 —— 只比开头会漏掉它。
    const dir = claudeTranscriptDirFor(await realpath(workspace));
    await rm(path.join(dir, `${CHILD}.jsonl`), { force: true });
    await rm(path.join(dir, `${GRANDCHILD}.jsonl`), { force: true });
    const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'b1' });
    await writeFile(
      path.join(dir, `${PARENT}.jsonl`),
      `${jsonl(['p1', 'p2'])}\n${boundary}\n${jsonl(['s1', 'p3'])}\n`
    );
    const COMPACTED_FORK = '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await writeFile(
      path.join(dir, `${COMPACTED_FORK}.jsonl`),
      `${JSON.stringify({ type: 'mode' })}\n${boundary}\n${jsonl(['s1', 'p3', 'f1'])}\n`
    );

    await captureExternalForks(projectId, PARENT);

    const rows = await fixture.db.select().from(sessions);
    expect(forkedFromId(rows.find((row) => row.id === COMPACTED_FORK))).toBe(PARENT);
  });

});

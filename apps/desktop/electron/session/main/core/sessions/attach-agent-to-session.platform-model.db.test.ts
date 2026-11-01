import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { setTaskNamer } from './task-name';

// Sessions are named at creation by the host's namer (task-name.ts); number defaults per provider.
beforeEach(() => setTaskNamer({ defaultName: async (provider, taken) => `${provider} ${taken.length + 1}`, renameBound: async () => { throw new Error("no identities in this test") } }));
afterEach(() => setTaskNamer(null));

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  startSession: vi.fn(async () => {}),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: { emitAgentEvent: vi.fn() },
}));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({
  agentStatusWriter: { birth: vi.fn(async () => undefined) },
}));
vi.mock('../agents/plugin-registry', () => ({ getPlugin: () => ({}) }));
// fork 只对能在来源那条腿上分叉的 provider 开放,attachAgentToSession 会先问这一句。
vi.mock('../agents/fork-legs', () => ({ forkRuntimes: () => ['pty', 'acp'] }));
vi.mock('../projects/utils', () => ({
  resolveSession: () => ({ sessions: { startSession: mocks.startSession } }),
}));
vi.mock('./session-events', () => ({ sessionEvents: { _emit: vi.fn() } }));
// 落行之后挂载这条会话:挂载本身(工作区、provider)不是这里的命题。
vi.mock('./spawn-session', () => ({
  mountSpawnedSession: async () => ({ workspaceId: 'workspace-1', path: '/repo' }),
}));

const { attachAgentToSession } = await import('./attach-agent-to-session');
const { sessionEvents } = await import('./session-events');
const { sessionPlatformModel, recordSessionPlatformModel } = await import(
  './platform-model-selection'
);

const PROJECT = 'project-1';
const SOURCE = 'conv-source';

describe('#2503 fork 继承源会话的 composer 模型选择', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.startSession.mockClear();
    fixture.sqlite
      .prepare(
        `INSERT INTO projects (id, name, path, created_at, updated_at)
         VALUES (?, 'Project', '/repo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run(PROJECT);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  /** renderer 的 fork 是零输入操作:照抄源会话,载荷里没有 composer 的 platformModel 字段。 */
  async function fork(id: string): Promise<void> {
    await attachAgentToSession({
      id,
      projectId: PROJECT,
      workspaceId: 'workspace-1',
      provider: 'claude',
      title: '母会话-fork',
      type: 'pty',
      origin: { kind: 'fork', forkedFrom: { sessionId: SOURCE } },
      forkFromProviderSessionId: SOURCE,
    } as never);
  }

  it('carries a platform session into its fork', async () => {
    // 这是 SF-1 的核心:平台会话 fork 出来必须还在平台上。不继承的话,fork 落进「从没决策过」,
    // 回退 agent 级 → 多半是 BYOK,而 fork 的产品语义就是「照抄源会话」。
    await recordSessionPlatformModel(SOURCE, { modelId: 'glm-5.2' });

    await fork('conv-fork-platform');

    await expect(sessionPlatformModel('conv-fork-platform')).resolves.toEqual({
      modelId: 'glm-5.2',
    });
  });

  it('carries an explicit harness pick into its fork too', async () => {
    // 反方向同样要准:源会话明确选了 harness,fork 不能因为「没记录」而回退到 agent 级平台配置。
    await recordSessionPlatformModel(SOURCE, null);

    await fork('conv-fork-harness');

    await expect(sessionPlatformModel('conv-fork-harness')).resolves.toBeNull();
  });

  it('records nothing when the source never had a decision either', async () => {
    // 存量源会话没有记录 → fork 也不该凭空得到一条。回退语义原样传下去。
    await fork('conv-fork-legacy');

    await expect(sessionPlatformModel('conv-fork-legacy')).resolves.toBeUndefined();
  });

  it('lets an explicit choice on the payload win over what the source had', async () => {
    // ❌ 别用 `?? 继承` 写这段:`??` 会把「明确选了 harness」的 null 也当空值,于是显式的 BYOK
    // 选择被源会话的平台记录顶掉。这条用例就是钉死那个坑。
    await recordSessionPlatformModel(SOURCE, { modelId: 'glm-5.2' });

    await attachAgentToSession({
      id: 'conv-fork-explicit',
      projectId: PROJECT,
      workspaceId: 'workspace-1',
      provider: 'claude',
      title: '母会话-fork',
      type: 'pty',
      platformModel: null,
      origin: { kind: 'fork', forkedFrom: { sessionId: SOURCE } },
      forkFromProviderSessionId: SOURCE,
    } as never);

    await expect(sessionPlatformModel('conv-fork-explicit')).resolves.toBeNull();
  });

  it('记下 Chat UI 会话的平台选择,不再当场拒绝', async () => {
    // 从前这里有一道创建期的墙:type='acp' 又选了咕咕的模型 → 直接抛错(理由是平台额度只在 pty
    // 启动路径上注入,收下也不会生效)。现在 ACP 启动链自己带注入了,墙拆掉 —— 这条用例就是钉死
    // 「Chat UI 会话的选择必须被记住」:记不下,启动时读回来就是 undefined,于是回退 agent 级配置,
    // 用户在 composer 里选的那个模型静默失效。
    await attachAgentToSession({
      id: 'conv-acp-platform',
      projectId: PROJECT,
      workspaceId: 'workspace-1',
      provider: 'claude',
      title: 'Chat UI 会话',
      type: 'acp',
      platformModel: { modelId: 'glm-5.2' },
      origin: { kind: 'create', firstUtterance: '开工' },
    } as never);

    await expect(sessionPlatformModel('conv-acp-platform')).resolves.toEqual({
      modelId: 'glm-5.2',
    });
  });

  it('records nothing for a plain creation path that carries no composer field', async () => {
    // 会话管理 MCP 派生的子会话、导入等路径没有 composer —— 不记录,沿用 agent 级默认。
    await attachAgentToSession({
      id: 'conv-plain',
      projectId: PROJECT,
      workspaceId: 'workspace-1',
      provider: 'claude',
      title: '新会话',
      type: 'pty',
      origin: { kind: 'create', firstUtterance: '开工' },
    } as never);

    await expect(sessionPlatformModel('conv-plain')).resolves.toBeUndefined();
  });

  // 状态写入者从进程内的出生事实开日志;出生晚于 spawn,hook 就可能先到,出生反而盖掉它们。
  describe('出生先于开口', () => {
    let order: string[];
    beforeEach(() => {
      order = [];
      vi.mocked(sessionEvents._emit).mockImplementation((...args) => {
        if (args[0] === 'session:created') order.push('born');
      });
    });

    it('conversation:created 在 spawn 之前发出,且只发一次', async () => {
      mocks.startSession.mockImplementationOnce(async () => {
        order.push('spawn');
      });
      await fork('conv-birth-order');
      expect(order).toEqual(['born', 'spawn']);
    });

    it('首次 spawn 失败也只出生一次', async () => {
      mocks.startSession.mockImplementationOnce(async () => {
        order.push('spawn');
        throw new Error('spawn failed');
      });
      await expect(fork('conv-birth-failed')).rejects.toThrow('spawn failed');
      expect(order).toEqual(['born', 'spawn']);
    });
  });
});

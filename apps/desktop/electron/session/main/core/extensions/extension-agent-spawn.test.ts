import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 扩展起 agent(R 第 3 段,真源原则 13):不再另写一份继承,走 `session_spawn` 那一条起会话的路(`spawnSessionForApp`,
 * session-orchestration.db.test.ts 判它起什么、在哪儿起、照谁起)。这里判扩展这一侧交出去的是什么、答回来的是什么:
 * 调用点名的原话、来自「扩展名」的信封,答它的身份 user:<uuid>。
 * 对照组(父提交 1a60bdbf45):这条路自己读页面所在那条会话的行、自己落行起引擎,失败自己回滚 —— 和宿主那条各写一份。
 */

const spawned: Record<string, unknown>[] = [];
let identities = new Map<string, string>();
vi.mock('@main/core/sessions/session-orchestration', () => ({
  spawnSessionForApp: async (input: Record<string, unknown>) => {
    spawned.push(input);
    return { id: 'conv-new' };
  },
}));
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ agentIdsBySession: async () => identities }));
vi.mock('@main/core/sessions/getSessions', () => ({ getSessions: async () => [] }));
vi.mock('@main/core/acp/session-summary-reader', () => ({ readAcpSessionSummaries: async () => ({}) }));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/lib/logger', () => ({ log: { error: () => {}, warn: () => {}, info: () => {} } }));

const { spawnAgentForExtension } = await import('./extension-agents');

/** 信封里那段正文(CDATA)。 */
function body(envelope: string): string {
  return /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(envelope)?.[1] ?? '';
}

beforeEach(() => {
  spawned.length = 0;
  identities = new Map([['conv-new', 'user:0a000000-0000-4000-8000-0000000000e1']]);
});

describe('扩展起 agent:交给宿主那一条起会话的路', () => {
  it('调用点名的原样交出去(引擎、模型、形态、项目、出生的对话、标题),答它的 user:<uuid>', async () => {
    const answer = await spawnAgentForExtension({
      extensionId: 'ext-debug',
      extensionName: '调试台',
      prompt: '干活',
      title: '调试台起的',
      harness: 'codex',
      model: 'platform:gpt-5.6',
      transport: 'acp',
      project: 'project-2',
      chat: 'chat-7',
    });
    expect(answer).toEqual({ agentId: 'user:0a000000-0000-4000-8000-0000000000e1' });
    expect(spawned[0]).toMatchObject({
      extensionId: 'ext-debug',
      prompt: '干活',
      title: '调试台起的',
      harness: 'codex',
      model: 'platform:gpt-5.6',
      transport: 'acp',
      project: 'project-2',
      chat: 'chat-7',
    });
  });

  it('首轮是来自「扩展名」的信封(与 send 同形),原话在里面', async () => {
    await spawnAgentForExtension({ extensionId: 'ext-debug', extensionName: '调试台', prompt: '干活' });
    const envelope = (spawned[0]!.envelope as (messageId: string, text: string) => string)('m-1', '干活');
    expect(envelope).toContain('route="extension"');
    expect(envelope).toContain('调试台');
    expect(body(envelope)).toContain('干活');
  });

  it('起来了却还没有身份:说出来,❌ 答一个编出来的 id', async () => {
    identities = new Map();
    await expect(spawnAgentForExtension({ extensionId: 'ext-debug', extensionName: '调试台', prompt: '干活' })).rejects.toThrow(/has no identity yet/);
  });
});

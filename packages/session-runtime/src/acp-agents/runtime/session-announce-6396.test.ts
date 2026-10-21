import { describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

// #6396 宿主告诉一条活会话一件事(它的 agent 登记时名字已被占用):对话里一行,不单独起一轮。
// #6490 这一行只给人看 ❌ 进 agent 的上下文:名字不在 agent 的上下文里,要知道就调 profile_whoami。
const renamed = {
  code: 'agent-renamed' as const,
  detail: '"Claude 29" had already been used when this session registered its identity; registered as "Claude 30"',
  previousValue: 'Claude 29',
  effectiveValue: 'Claude 30',
};

const promptTexts = (call: unknown[]): string[] =>
  ((call[0] as { prompt: Array<{ type: string; text?: string }> }).prompt)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '');

describe('#6396 announceSession', () => {
  it('会话已就绪:当场画一行(进历史、落盘),❌ 不单独起一轮,❌ 挂进 agent 的下一轮', async () => {
    const onTurnCommitted = vi.fn();
    const h = makeAcpHarness({ onTurnCommitted });
    h.agent.newSession.mockResolvedValue({ sessionId: 'renamed-session' });
    const runtime = new AcpRuntime(h.deps);
    try {
      expect((await runtime.startSession(makeStartInput({ sessionId: 'renamed' }))).success).toBe(true);
      expect(runtime.announceSession({ sessionId: 'renamed', notice: renamed }))
        .toEqual({ delivered: true });
      expect(h.agent.prompt, '一条通知不该让 agent 回一句话').not.toHaveBeenCalled();
      const row = runtime.getChatHistory('renamed').committed
        .flatMap((turn) => turn.items)
        .find((item) => item.kind === 'session-notice');
      expect(row).toMatchObject({ code: 'agent-renamed', previousValue: 'Claude 29', effectiveValue: 'Claude 30' });
      expect(JSON.stringify(onTurnCommitted.mock.calls), '行要落盘,重开还在').toContain('agent-renamed');

      await runtime.sendPrompt('renamed', { text: 'hello', origin: 'typed' });
      await h.agent.called('prompt');
      expect(h.agent.prompt).toHaveBeenCalledOnce();
      expect(promptTexts(h.agent.prompt.mock.calls[0]!)).toEqual(['hello']);
    } finally { await runtime.dispose(); }
  });

  it('会话还在起(记录在 start 那一拍就建了):那一行等就绪之后画 —— 与启动期的降级通知同一个落点', async () => {
    const h = makeAcpHarness();
    const modelOptions = [{
      id: 'model', name: 'Model', category: 'model' as const, type: 'select' as const,
      currentValue: 'model-a', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }],
    }];
    h.agent.newSession.mockResolvedValue({ sessionId: 'starting-session', configOptions: modelOptions });
    let releaseModel!: () => void;
    h.agent.setSessionConfigOption.mockImplementationOnce(() => new Promise((resolve) => {
      releaseModel = () => resolve({ configOptions: modelOptions.map((o) => ({ ...o, currentValue: 'model-b' })) });
    }));
    const runtime = new AcpRuntime(h.deps);
    try {
      const start = runtime.startSession(makeStartInput({ sessionId: 'starting', model: 'model-b' }));
      await h.agent.called('setSessionConfigOption');
      expect(runtime.announceSession({ sessionId: 'starting', notice: renamed }))
        .toEqual({ delivered: true });
      expect(JSON.stringify(runtime.getChatHistory('starting'))).not.toContain('agent-renamed');
      releaseModel();
      expect((await start).success).toBe(true);
      expect(JSON.stringify(runtime.getChatHistory('starting'))).toContain('agent-renamed');
    } finally { await runtime.dispose(); }
  });

  it('不在这个运行时里的会话(终端会话 / 已经停了)⇒ delivered:false,由宿主处置', async () => {
    const h = makeAcpHarness();
    const runtime = new AcpRuntime(h.deps);
    try {
      expect(runtime.announceSession({ sessionId: 'nowhere', notice: renamed }))
        .toEqual({ delivered: false });
    } finally { await runtime.dispose(); }
  });
});

/**
 * #7223 建来常驻、一句没聊过的 agent:引擎说没有这条原生会话时,同一次启动里改走 `session/new`。
 *
 * 形状:建来常驻、一句没聊的 agent。适配器建会话时就发了原生会话 id,Claude Code 要真聊过一轮才写下记录;
 * 机器重启(或适配器中途死掉、留下 lost 记录)后按这个 id 续接,得到 `Resource not found`。
 * 从前这一格直接报 provider_session_missing,每次唤醒都失败,私聊永远没人回。
 *
 * 宿主只在「没有已提交回合、也没有首轮」时带上 `freshIfProviderSessionMissing`;没带 = 聊过或记着首轮,
 * 照旧如实报 missing(阴控)。新开时照现有降级画「往上的内容它没有」那条界:「没聊过」是宿主推断的,万一判错要如实告知。
 */
import { describe, expect, it, vi } from 'vitest';
import { isOk } from '@gugu/session-shared';
import { makeAcpHarness, makeStartInput, untilSessionSummary } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const missing = () => ({ code: -32600, message: 'no rollout found for thread id 019ff4fc-1e4b-7a20-a24a-353f95aa51b6' });

function resetLines(rt: AcpRuntime, sessionId: string): number {
  const history = rt.getHistory(sessionId);
  if (!isOk(history)) throw new Error('no history');
  const turns = history.data.turns;
  return turns.flatMap((turn) => turn.items as Array<{ kind: string }>).filter((it) => it.kind === 'context-reset').length;
}

describe('#7223 引擎没有这条、而它是一句没聊过的常驻 agent', () => {
  it('同一次启动里新开:成功、拿到新 id,照降级画一条界', async () => {
    const h = makeAcpHarness();
    h.agent.loadSession = vi.fn(async () => {
      throw missing();
    });
    h.agent.newSession.mockResolvedValue({ sessionId: 'session-fresh' });
    const rt = new AcpRuntime(h.deps);

    const result = await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-never-ran', freshIfProviderSessionMissing: true }),
      providerSessionId: 'session-gone',
    });

    expect(result).toMatchObject({ success: true, data: { providerSessionId: 'session-fresh' } });
    expect(h.agent.loadSession).toHaveBeenCalledTimes(1);
    expect(h.agent.newSession).toHaveBeenCalledTimes(1);
    expect(rt.getSessionState('conv-never-ran').lifecycle).toBe('ready');
    // 建来常驻的没有首轮:空着起,❌ 凭空发一轮。
    expect(h.agent.prompt).not.toHaveBeenCalled();
    // 界先落在活动轮里,下一句话把那一轮收口之后才进已提交层(同 #5381 的用例)。
    await rt.sendPrompt('conv-never-ran', { text: '在吗', origin: 'manual' });
    expect(resetLines(rt, 'conv-never-ran')).toBe(1);
  });

  it('阴控 —— 没带这一格(聊过的):照旧报 provider_session_missing,❌ session/new', async () => {
    const h = makeAcpHarness();
    h.agent.loadSession = vi.fn(async () => {
      throw missing();
    });
    const rt = new AcpRuntime(h.deps);

    const result = await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-chatted' }),
      providerSessionId: 'session-gone',
    });

    expect(result).toEqual({ success: false, error: expect.objectContaining({ type: 'provider_session_missing' }) });
    expect(h.agent.newSession).not.toHaveBeenCalled();
  });

  it('引擎那边其实还有(load 成功):照常续上,❌ 新开', async () => {
    const h = makeAcpHarness();
    h.agent.loadSession = vi.fn(async () => ({}));
    const rt = new AcpRuntime(h.deps);

    const result = await rt.resumeSession({
      ...makeStartInput({
        sessionId: 'conv-still-there',
        freshIfProviderSessionMissing: true,
      }),
      providerSessionId: 'session-old',
    });

    expect(result).toMatchObject({ success: true, data: { providerSessionId: 'session-old' } });
    expect(h.agent.newSession).not.toHaveBeenCalled();
    await rt.sendPrompt('conv-still-there', { text: '在吗', origin: 'manual' });
    expect(resetLines(rt, 'conv-still-there')).toBe(0);
  });

  it('启动途中排进来的那句不丢:新开之后发往新开的那条,❌ 发往不存在的旧会话', async () => {
    const h = makeAcpHarness();
    let failLoad!: () => void;
    h.agent.loadSession = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          failLoad = () => reject(missing());
        })
    );
    h.agent.newSession.mockResolvedValue({ sessionId: 'session-fresh' });
    const rt = new AcpRuntime(h.deps);

    const starting = rt.resumeSession({
      ...makeStartInput({
        sessionId: 'conv-queued',
        freshIfProviderSessionMissing: true,
      }),
      providerSessionId: 'session-gone',
    });
    await h.agent.called('loadSession');
    const queued = rt.queuePrompt('conv-queued', { text: '在吗', origin: 'manual' });
    failLoad();

    expect(await starting).toMatchObject({ success: true, data: { providerSessionId: 'session-fresh' } });
    expect(await queued).toMatchObject({ success: true });
    await h.agent.called('prompt');
    expect(h.agent.prompt.mock.calls.map((c) => (c[0] as { sessionId: string }).sessionId)).toEqual(['session-fresh']);
    expect(JSON.stringify(h.agent.prompt.mock.calls)).toContain('在吗');
  });

  it('适配器中途死掉留下 lost 记录:重连钉回旧 id、引擎说没有 ⇒ 照样新开(评审 #1)', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    // 建来常驻:起来了、拿到了原生 id,但一轮都没跑。
    await rt.startSession(makeStartInput({ sessionId: 'conv-lost' }));
    h.lastChild.emitExit(137);
    await untilSessionSummary(rt, 'conv-lost', 'adapter exit marks the session lost', (s) => s?.lifecycle === 'lost');

    h.agent.loadSession = vi.fn(async () => {
      throw missing();
    });
    h.agent.newSession.mockResolvedValue({ sessionId: 'session-fresh' });
    // 宿主这一次传的是 null 也没用 —— lost 记录会把 session-1 钉回去;要靠的是这一格。
    const result = await rt.startSession(
      makeStartInput({ sessionId: 'conv-lost', freshIfProviderSessionMissing: true })
    );

    expect(h.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
    expect(result).toMatchObject({ success: true, data: { providerSessionId: 'session-fresh' } });
    expect(rt.getSessionState('conv-lost').lifecycle).toBe('ready');
  });

  it('阴控 —— lost 记录、没带这一格:照旧报 missing,会话仍是 lost', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({ sessionId: 'conv-lost-chatted' }));
    h.lastChild.emitExit(137);
    await untilSessionSummary(rt, 'conv-lost-chatted', 'adapter exit marks the session lost', (s) => s?.lifecycle === 'lost');

    h.agent.loadSession = vi.fn(async () => {
      throw missing();
    });
    const result = await rt.startSession(makeStartInput({ sessionId: 'conv-lost-chatted' }));

    expect(result).toEqual({ success: false, error: expect.objectContaining({ type: 'provider_session_missing' }) });
    expect(rt.getSessionState('conv-lost-chatted').lifecycle).toBe('lost');
  });
});

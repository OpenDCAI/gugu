import type { PermissionOptionKind } from '@agentclientprotocol/sdk';
import type { LiveSettingsCapability } from '@gugu/session-core/agents/plugins';
import { isOk } from '@gugu/session-shared';
import { noopLogger } from '@gugu/session-shared/logger';
import { describe, expect, it, vi } from 'vitest';
import { permissionWaitKind } from '@gugu/session-core/acp';
import { FakeAcpAgent } from '../acp-test-support';
import { SessionCell } from './cell';

/** 桩:只证明「当面轮走了注入的这条缝」;真信封字节由 core 自己的单测判(一个 producer 一个真相)。 */
/** 默认注入一个信封属主桩:真实体是 core 的 mergeDeliveryEnvelopes,由宿主接线(见 entry.ts)。 */
const stubMergeEnvelopes = (texts: readonly string[]): string =>
  `<gugu_deliveries count="${texts.length}">${texts.join('')}</gugu_deliveries>`;

const TEST_LIVE_SETTINGS: LiveSettingsCapability = {
  model: {
    channel: 'acp-config-option',
    ack: 'ack',
    busy: 'queue-next-turn',
    reloadRequired: false,
    recovery: 'none',
  },
  permission: {
    channel: 'acp-config-option',
    ack: 'ack',
    busy: 'queue-next-turn',
    reloadRequired: false,
    recovery: 'none',
  },
  effort: {
    channel: 'acp-config-option',
    ack: 'ack',
    busy: 'queue-next-turn',
    reloadRequired: false,
    recovery: 'none',
  },
};

function makeCell(agent = new FakeAcpAgent(), extra: Record<string, unknown> = {}) {
  const cell = new SessionCell({
    mergeEnvelopes: stubMergeEnvelopes,
    sessionId: 'conv-1',
    projectId: 'proj-1',
    providerId: 'claude',
    acpSessionId: 'session-1',
    agent,
    liveSettings: TEST_LIVE_SETTINGS,
    resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
    logger: noopLogger,
    ...extra,
  });
  cell.applySessionReady();
  return { cell, agent };
}

/**
 * 连锁出队是一串微/宏任务。flush 少了会把「还没发完」读成「只发了一条」——
 * 那正好是这条判据要判的那一格,所以次数断言必须配足量 flush。
 */
async function flushDrains(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SessionCell prompts', () => {
  it('does not project a non-permission stable modes mirror into session config', () => {
    const { cell } = makeCell(undefined, { sessionModes: 'none' });
    const modes = {
      currentModeId: 'medium',
      availableModes: [
        { id: 'off', name: 'Off' },
        { id: 'medium', name: 'Medium' },
      ],
    };

    cell.applySessionMeta({ modes });
    cell.push({ kind: 'modes_state', ...modes });
    cell.push({ kind: 'mode_selected', modeId: 'medium' });

    expect(cell.config.modeOptions).toBeNull();
  });

  it('sends a typed turn as the person own words and omits delivery-only context', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    await cell.prompt({ text: '看下 #4456', hiddenContext: '<issue_context/>', origin: 'typed' });

    const request = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.prompt).toHaveLength(1);
    expect(request.prompt[0]).toEqual({
      type: 'text',
      text: '看下 #4456',
    });
    // 记录里那条 user 消息仍然只有他自己那句话:信封是 provider 可见字节,不是他说的话。
    const item = cell.history().committed[0].items[0];
    expect(item).toMatchObject({ kind: 'message', role: 'user', text: '看下 #4456' });
  });

  // ── 命令必须是第一个块 ──────────────────────────────────────────────────────
  //
  // 三家 harness 都只在 prompt 的开头找命令(claude / codex 只读 `prompt[0]`,opencode 把
  // 所有 text 块拼起来判首字符)。所以带图片发 `/review` 时,文本块必须排到附件前面。
  //
  // 双向控:第二条钉住**不是命令**的普通话仍然排在附件后面 —— 只断言第一条,会被一个
  // 「永远把文本放最前」的实现满足,那就把附件语序整个改掉了。
  it('puts an advertised command first so the agent can see it (#5137)', async () => {
    const { cell, agent } = makeCell();
    cell.push({ kind: 'commands', commands: [{ name: 'review', description: '' }] });
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    await cell.prompt({
      text: '/review this',
      attachments: [{ type: 'attachment', id: 'a1', name: 'shot.png', mimeType: 'image/png' }],
    });

    const request = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.prompt[0]).toEqual({ type: 'text', text: '/review this' });
    expect(request.prompt[1]).toMatchObject({ type: 'image' });
  });

  // #6264 另一台机器发来的图(以及首轮随启动队列带的图)是按路径带的 `local-file`:正文里已经有它的
  // 路径 mention。agent 握手时说收图片才另发图片块;说不收就只留路径 —— ❌ 给它塞一个它声明不认的块。
  it('sends a path-carried image as an image block only when the agent accepts images (#6264)', async () => {
    const image = { type: 'local-file' as const, originalPath: '/r/abcdef0123456789/red.png', mimeType: 'image/png' as const, name: 'red.png' };

    const accepting = makeCell(undefined, { acceptsImagePrompts: true });
    accepting.agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    await accepting.cell.prompt({ text: '看图 @[red.png](/r/abcdef0123456789/red.png)', attachments: [image] });
    const withImage = (accepting.agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
    expect(withImage.map((block: { type: string }) => block.type)).toEqual(['image', 'text']);

    const declining = makeCell(undefined, { acceptsImagePrompts: false });
    declining.agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    await declining.cell.prompt({ text: '看图 @[red.png](/r/abcdef0123456789/red.png)', attachments: [image] });
    const textOnly = (declining.agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
    expect(textOnly).toEqual([{ type: 'text', text: '看图 @[red.png](/r/abcdef0123456789/red.png)' }]);
  });

  it('leaves an ordinary prompt behind its attachments (#5137 阴控)', async () => {
    const { cell, agent } = makeCell();
    cell.push({ kind: 'commands', commands: [{ name: 'review', description: '' }] });
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    // 以 `/` 开头但**不是**它报过的命令 —— 这就是 opencode 会整轮吞掉的那种路径开头的话。
    await cell.prompt({
      text: '/Users/me/shot.png 看一下',
      attachments: [{ type: 'attachment', id: 'a1', name: 'shot.png', mimeType: 'image/png' }],
    });

    const request = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.prompt[0]).toMatchObject({ type: 'image' });
    expect(request.prompt[1]).toEqual({ type: 'text', text: '/Users/me/shot.png 看一下' });
  });

  it('leaves already-enveloped delivered bytes alone', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    await cell.prompt({ text: '<gugu_delivery route="chat">…</gugu_delivery>', origin: 'communication' });

    const request = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.prompt).toEqual([
      { type: 'text', text: '<gugu_delivery route="chat">…</gugu_delivery>' },
    ]);
  });

  it('synthesizes a user message and settles the turn', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    const result = await cell.prompt({ text: 'hello' });

    expect(result).toEqual({ success: true, data: { queued: false } });
    expect(agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'hello' }],
    });
    const history = cell.history();
    expect(history.active).toBeNull();
    expect(history.committed).toHaveLength(1);
    expect(history.committed[0].items[0]).toMatchObject({
      kind: 'message',
      role: 'user',
      text: 'hello',
    });
    expect(history.committed[0].outcome).toEqual({ kind: 'done', reason: 'end_turn' });
  });

  it('stores prompt drafts by monotonic revision and clears them after submit', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    expect(isOk(cell.setPromptDraft({ rev: 1, input: { text: 'old' } }))).toBe(true);
    expect(isOk(cell.setPromptDraft({ rev: 1, input: { text: 'stale' } }))).toBe(true);
    expect(cell.promptDraft).toMatchObject({ text: 'old', rev: 1 });

    expect(isOk(cell.setPromptDraft({ rev: 2, input: { text: 'new' } }))).toBe(true);
    expect(cell.promptDraft).toMatchObject({ text: 'new', rev: 2 });

    await cell.prompt({ text: 'send' });
    expect(cell.promptDraft).toBeNull();
  });

  it.each(['end_turn', 'cancelled'] as const)(
    'keeps the next draft when the running prompt finishes with %s',
    async (stopReason) => {
      const { cell, agent } = makeCell();
      let finish!: (result: { stopReason: typeof stopReason }) => void;
      agent.prompt = vi.fn(() => new Promise<{ stopReason: typeof stopReason }>((resolve) => { finish = resolve; }));
      const sending = cell.prompt({ text: 'first', origin: 'manual' });
      await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
      cell.setPromptDraft({ rev: 100, input: { text: '我还没打完的下一句' } });

      finish({ stopReason });
      await sending;

      expect(cell.promptDraft?.text).toBe('我还没打完的下一句');
    },
  );

  it('clears the submitted draft as soon as the prompt is admitted', async () => {
    const { cell, agent } = makeCell();
    let finish!: (result: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn(() => new Promise<{ stopReason: 'end_turn' }>((resolve) => { finish = resolve; }));
    cell.setPromptDraft({ rev: 1, input: { text: 'send' } });

    const sending = cell.prompt({ text: 'send', origin: 'manual' });
    const draftAfterAdmission = cell.promptDraft;
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1));
    finish({ stopReason: 'end_turn' });
    await sending;

    expect(draftAfterAdmission).toBeNull();
  });

  it('keeps the draft when a closed session rejects the prompt', async () => {
    const { cell, agent } = makeCell();
    cell.setPromptDraft({ rev: 1, input: { text: 'not sent' } });
    cell.processClosed({ exitCode: 0, signal: null, stderrTail: '' }, { abnormal: false });

    const result = await cell.prompt({ text: 'not sent', origin: 'manual' });

    expect(result.success).toBe(false);
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(cell.promptDraft?.text).toBe('not sent');
  });

  it('queues while working and drains after the active turn settles', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ stopReason: 'end_turn' }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'first', origin: 'typed' });
    const second = await cell.prompt({ text: 'second', origin: 'typed' });

    expect(second).toEqual({ success: true, data: { queued: true } });
    expect(cell.sessionState.queuedPrompts).toHaveLength(1);
    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect(cell.sessionState.queuedPrompts).toHaveLength(0);
  });

  it('never publishes a dequeued prompt as absent from both queue and transcript', async () => {
    const snapshots: Array<{ queuedIds: string[]; activeTexts: string[] }> = [];
    let cellRef: SessionCell | null = null;
    const capture = () => {
      if (!cellRef) return;
      snapshots.push({
        queuedIds: cellRef.sessionState.queuedPrompts.map((prompt) => prompt.id),
        activeTexts: cellRef.history().active?.items.flatMap((item) =>
          item.kind === 'message' && item.role === 'user' ? [item.text] : []
        ) ?? [],
      });
    };
    const { cell, agent } = makeCell(new FakeAcpAgent(), {
      callbacks: {
        onSessionStateChanged: capture,
        onTranscriptChanged: capture,
      },
    });
    cellRef = cell;
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    let resolveManual!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; })
      )
      .mockImplementationOnce(
        () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveManual = resolve; })
      );

    const first = cell.prompt({ text: 'busy', origin: 'typed' });
    await cell.prompt({ text: 'manual-queued', origin: 'manual' });
    snapshots.length = 0;
    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(snapshots).not.toContainEqual({ queuedIds: [], activeTexts: [] });
    expect(snapshots).toContainEqual({ queuedIds: [], activeTexts: ['manual-queued'] });

    resolveManual({ stopReason: 'end_turn' });
    await flushDrains();
  });

  // owner #4652:队列不是「一条一轮」的节流器,它是人在等回合时攒下的一段话 ⇒ 回合结束一次抽干,
  // 合成一条。量在 **provider 边界**(agent.prompt 收到几次、那次正文是什么),❌ 不看 UI:产品会把
  // 两轮画成一条连续回合,只看截图必然读成「合并成功了」(#4500 §5.3)。
  it('drains the whole typed queue into one prompt when the turn ends', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ stopReason: 'end_turn' }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'first', origin: 'typed' });
    await cell.prompt({ text: 'q1', origin: 'typed' });
    await cell.prompt({ text: 'q2', origin: 'typed' });
    await cell.prompt({ text: 'q3', origin: 'typed' });
    expect(cell.sessionState.queuedPrompts).toHaveLength(3);

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();

    // 主断言:那**一次**发送里三条都在。合并前第二次调用只有 'q1' ⇒ 必红,且不受 flush 次数影响
    // (次数断言会;所以它不能当主断言)。
    const sends = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(sends[1].prompt).toEqual([{ type: 'text', text: 'q1\n\nq2\n\nq3' }]);
    expect(cell.sessionState.queuedPrompts).toHaveLength(0);
    // 归轮只信这里自己的父子关系:两个 committed turn,第二个的 user 消息就是合并那条。
    const committed = cell.history().committed;
    expect(committed).toHaveLength(2);
    expect(committed[1].items[0]).toMatchObject({
      kind: 'message',
      role: 'user',
      text: 'q1\n\nq2\n\nq3',
    });
  });

  // 两条**互不相干**的边界,分开判(它们曾挤在一个判别式里,导致 owner 只要求反转信封那条时
  // 附件那条差点被顺手一起反掉,#4652):
  //   · typed 与 envelope 各自成批、**互不混**(信封自己也会成批,见下一条);
  //   · 带附件的条目**单走一轮** —— 图片在 provider 请求里排正文之前,拼接会让图↔文对不上号。
  it('keeps envelopes out of the typed batch and keeps attachment entries on their own turn', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ stopReason: 'end_turn' }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'first', origin: 'typed' });
    await cell.prompt({ text: 'typed-a', origin: 'typed' });
    await cell.prompt({ text: '<gugu_delivery route="chat">…</gugu_delivery>', origin: 'communication' });
    await cell.prompt({
      text: 'with-image',
      origin: 'typed',
      attachments: [{ type: 'attachment', id: 'att-1', mimeType: 'image/png' }],
    });
    await cell.prompt({ text: 'typed-b', origin: 'typed' });

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();

    const sends = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].prompt
    );
    expect(sends).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'typed-a' }],
      [{ type: 'text', text: '<gugu_delivery route="chat">…</gugu_delivery>' }],
      [
        { type: 'image', data: '', mimeType: 'image/png' },
        { type: 'text', text: 'with-image' },
      ],
      [{ type: 'text', text: 'typed-b' }],
    ]);
  });

  // owner #4652:几十个 agent 辩论时,回合期间攒下的信封也要合成一条抽干。
  // 拼接交给**宿主注入的唯一属主**(core 的 mergeDeliveryEnvelopes),cell 只负责调用它。
  it('merges a run of queued delivery envelopes through the injected single owner', async () => {
    const mergeEnvelopes = vi.fn(stubMergeEnvelopes);
    const { cell, agent } = makeCell(new FakeAcpAgent(), { mergeEnvelopes });
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; })
      )
      .mockResolvedValue({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'busy', origin: 'typed' });
    await cell.prompt({ text: '<gugu_delivery from="a"/>', origin: 'communication' });
    await cell.prompt({ text: '<gugu_delivery from="b"/>', origin: 'communication' });
    await cell.prompt({ text: '<gugu_delivery from="c"/>', origin: 'communication' });

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();

    // 三条信封 ⇒ provider 只多收到一次,正文是**属主**拼出来的那一段。
    expect(mergeEnvelopes).toHaveBeenCalledTimes(1);
    expect(mergeEnvelopes.mock.calls[0][0]).toEqual([
      '<gugu_delivery from="a"/>',
      '<gugu_delivery from="b"/>',
      '<gugu_delivery from="c"/>',
    ]);
    const sends = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(sends[1].prompt).toEqual([
      { type: 'text', text: '<gugu_deliveries count="3"><gugu_delivery from="a"/><gugu_delivery from="b"/><gugu_delivery from="c"/></gugu_deliveries>' },
    ]);
    expect(cell.sessionState.queuedPrompts).toHaveLength(0);
  });

  // ❌ 没注入属主时不许悄悄退回空行拼接 —— 那等于在 cell 里长出第二个信封属主。
  it('fails loud when a multi-envelope batch has no injected merge owner', async () => {
    const { cell, agent } = makeCell(new FakeAcpAgent(), { mergeEnvelopes: undefined });
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; })
      )
      .mockResolvedValue({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'busy', origin: 'typed' });
    await cell.prompt({ text: '<gugu_delivery from="a"/>', origin: 'communication' });
    await cell.prompt({ text: '<gugu_delivery from="b"/>', origin: 'communication' });

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();

    // 没有第二次发送:批被响亮拒绝,而不是被拼成一段没有归属的字节。
    expect(agent.prompt).toHaveBeenCalledTimes(1);
  });

  // #4660 反转:出队发送失败时,那一批**不回队列**。
  // 可见性不靠队列 —— 正文在发出去之前就作为 user 消息进了 transcript,失败把那一轮结算成 errored;
  // 而旧做法把它塞回队首,反而让同一批同时显示成「待发」(假的待发),且再没有事件会抽干它(滞留)。
  it('does not re-queue a failed batch; the attempt stays visible as an errored turn', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; })
      )
      .mockRejectedValueOnce(new Error('provider rate limited'))
      .mockResolvedValueOnce({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'first', origin: 'typed' });
    expect(await cell.prompt({ text: 'retry me', origin: 'typed' })).toEqual({ success: true, data: { queued: true } });
    expect(await cell.prompt({ text: 'later', origin: 'typed' })).toEqual({ success: true, data: { queued: true } });

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();

    // 只发了两次:首轮 + 失败那一批。❌ 没有第三次 —— 失败不自动重试(429 下重发越捅越糟)。
    expect(agent.prompt).toHaveBeenCalledTimes(2);
    // 队列里什么都没剩:失败的批没有回来占「待发」的位置。
    expect(cell.sessionState.queuedPrompts).toEqual([]);
    // 而它确实看得见:那一轮以 error 收场,正文就在里面。
    const failedTurn = cell.history().committed.at(-1);
    expect(failedTurn?.outcome).toMatchObject({
      kind: 'error',
      reason: 'prompt_failed',
      detail: 'provider rate limited',
    });
    expect(JSON.stringify(failedTurn?.items)).toContain('retry me');
  });

  it('logs and exports the serialized cause when a prompt fails', async () => {
    const logger = { ...noopLogger, error: vi.fn() };
    const { cell, agent } = makeCell(new FakeAcpAgent(), { logger });
    agent.prompt = vi.fn().mockRejectedValue(new Error('provider cause'));

    const result = await cell.prompt({ text: 'fails' });

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'prompt_failed',
        cause: { message: 'provider cause' },
      },
    });
    expect(logger.error).toHaveBeenCalledWith(
      'SessionCell: prompt failed',
      expect.objectContaining({
        sessionId: 'conv-1',
        providerId: 'claude',
        acpSessionId: 'session-1',
        cause: expect.objectContaining({ message: 'provider cause' }),
      })
    );

    const raw = JSON.parse(cell.exportRawLog()) as {
      events: Array<{ event: { kind: string; error?: { message?: string } } }>;
    };
    expect(raw.events.at(-1)?.event).toMatchObject({
      kind: 'prompt_result',
      error: { message: 'provider cause' },
    });
  });

  // #4725 对抗评审构造出的**剩余态**,钉在这里免得它变成"碰巧成立"。
  // 路径:批出队 → 发送在飞时又有新条目入队 → 该批失败 ⇒ settleTurn(error, dequeueQueuedPrompt:false)
  //       ⇒ 回合以 errored 收场、phase 回 ready,而队列里躺着那些新条目、没有自动触发。
  // ⚠️ 这**不是** #4660 的病:它不静默 —— 失败那轮在 transcript 上是 errored、条目留在队列里看得见,
  //    且不自动抽干正是 #4493 要的(429 下不许自动重发)。下一条 prompt 的 TurnEnded(dequeue 不被抑制)
  //    自然把它抽干 = 恢复口。⇒ 「静默滞留不可构造」成立;「响亮暂停可达」是设计,不是不变量的反例。
  it('a failed batch leaves a LOUD paused queue, and the next prompt drains it', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    let rejectBatch!: (reason: Error) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(() => new Promise<{ stopReason: 'end_turn' }>((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise<{ stopReason: 'end_turn' }>((_r, rej) => { rejectBatch = rej; }))
      .mockResolvedValue({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'first', origin: 'typed' });
    await cell.prompt({ text: 'batch', origin: 'typed' });

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();
    // 'batch' 已出队、发送在飞;此刻再排一条进来。
    await cell.prompt({ text: 'during', origin: 'typed' });

    rejectBatch(new Error('provider rate limited'));
    await flushDrains();

    // ① 失败是**响亮**的:那一轮以 error 收场,不是悄悄消失。
    expect(cell.history().committed.at(-1)?.outcome).toMatchObject({ kind: 'error', reason: 'prompt_failed' });
    // ② 期间入队的条目**留在队列里可见**(❌ 不自动重发 —— #4493)。
    expect(cell.sessionState.queuedPrompts.map((p) => p.text)).toEqual(['during']);
    expect(agent.prompt).toHaveBeenCalledTimes(2);

    // ③ 恢复口:下一条 prompt 的回合结束时把它抽干。
    await cell.prompt({ text: 'next', origin: 'typed' });
    await flushDrains();
    expect(cell.sessionState.queuedPrompts).toEqual([]);
    const sends = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].prompt[0]?.text);
    expect(sends).toContain('during');
  });

  /**
   * 改口的第二道闸:**只认异常退出**。
   *
   * 主动停会话 / 换模型重开 / 删会话都会走 `processClosed(..., { abnormal: false })` ——
   * 那不是故障,那一轮的说辞**一个字都不许动**。与「provider 说过话的不许改口」是同一族守卫:
   * 能不能改口是显式状态,❌ 不是「后来发生了什么」的时序推断。
   */
  it('主动收尾不改口:abnormal=false 时那一轮的说辞原样留着', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockRejectedValue(new Error('ACP connection closed'));

    await cell.prompt({ text: 'first', origin: 'typed' });
    await flushDrains();
    const settled = cell.history().committed.at(-1)?.outcome;
    // 阳控:这一条确实是**暂定**的那一类(传输层塌了)——否则下面的否定读数是空的。
    expect(settled).toMatchObject({ kind: 'error', reason: 'prompt_failed' });

    cell.processClosed({ exitCode: 0, signal: null, stderrTail: '' }, { abnormal: false });

    expect(cell.history().committed.at(-1)?.outcome).toEqual(settled);
  });

  it('settles an active turn before an unexpected process close', async () => {
    const { cell, agent } = makeCell();
    let resolvePrompt!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn(
      () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolvePrompt = resolve; })
    );

    const inFlight = cell.prompt({ text: 'first', origin: 'typed' });
    await flushDrains();
    await cell.prompt({ text: 'during', origin: 'typed' });

    cell.processClosed({ exitCode: 137, signal: null, stderrTail: '' });

    expect(cell.sessionState.lifecycle).toBe('lost');
    expect(cell.sessionState.failure).toMatchObject({ kind: 'adapter-exit', exitCode: 137 });
    expect(cell.sessionState.lastTurnOutcome).toBe('errored');
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual(['during']);
    // #5858:进程死亡有了自己的 reason —— 与「上游拒了」不再共用 `prompt_failed` 这个哨兵值。
    expect(cell.history().committed.at(-1)?.outcome).toMatchObject({
      kind: 'error',
      reason: 'process_closed',
      detail: 'exit code=137',
    });

    resolvePrompt({ stopReason: 'end_turn' });
    await inFlight;
  });

  // spec session-injection(next-tool-call 档的 mid-turn 支):同一条标准 session/prompt 立即发进
  // 当前 turn;在飞的主 RPC 拥有 turn 结算,steer RPC 无论先后结束都不 settleTurn。
  it('steers mid-turn: the second session/prompt leaves immediately and never settles the in-flight turn', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    let resolveSteer!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; })
      )
      .mockImplementationOnce(
        () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveSteer = resolve; })
      );

    const first = cell.prompt({ text: 'first' });
    const steer = cell.prompt({ text: 'mid-turn message' }, { steerIfBusy: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 立即发送(对照上一条 queues-while-working:同一时序无旗时是 queued + 只有 1 次调用)。
    expect(agent.prompt).toHaveBeenCalledTimes(2);
    const steerRequest = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(steerRequest.prompt).toEqual([{ type: 'text', text: 'mid-turn message' }]);
    expect(cell.sessionState.queuedPrompts).toHaveLength(0);
    expect(cell.sessionState.lifecycle).toBe('working');

    // 合入同一 turn 生命周期(opencode 实测读数的形状:两个响应在轮末先后到齐)。
    // steer 响应先回也不许结算 —— 结算权属于主 RPC。
    resolveSteer({ stopReason: 'end_turn' });
    await expect(steer).resolves.toEqual({ success: true, data: { queued: false } });
    expect(cell.sessionState.lifecycle).toBe('working');

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    expect(cell.sessionState.lifecycle).toBe('ready');

    // A native admission must not leave the legacy concurrent-steer counter armed for the
    // following turn: an unrelated cancelled result must still settle immediately.
    agent.prompt.mockResolvedValueOnce({ stopReason: 'cancelled' });
    await cell.prompt({ text: 'next turn' });
    expect(cell.sessionState.lifecycle).toBe('ready');
  });

  it('settles an end_turn as failed when the provider wrote its error as a reply (#6335)', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, {
      turnFailure: {
        fromAgentMessage: (text: string) => (text.startsWith('Agent execution error: ') ? text : null),
        watchesStderr: false,
      },
    });
    agent.prompt = vi.fn(async () => {
      cell.push({ kind: 'message', role: 'assistant', messageId: null, text: 'Agent execution error: code 400' });
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'hi' });
    const turn = cell.history().committed.at(-1)!;
    expect(turn.outcome).toEqual({ kind: 'error', reason: 'prompt_failed', detail: 'Agent execution error: code 400' });
    expect(JSON.stringify(turn.items)).not.toContain('Agent execution error');
  });

  it('settles a silent end_turn as failed when stderr reported the failure a moment later (#6335)', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { turnFailure: { watchesStderr: true } });
    agent.prompt = vi.fn(async () => {
      setTimeout(() => cell.noteProviderStderrFailure('Agent run failed: cascade ID mismatch'), 50);
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'hi' });
    expect(cell.history().committed.at(-1)!.outcome).toEqual({
      kind: 'error',
      reason: 'prompt_failed',
      detail: 'Agent run failed: cascade ID mismatch',
    });
  });

  it('a stderr failure the provider marks as a credential failure settles with signInRequired (MiMo, 10-07)', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { turnFailure: { watchesStderr: true } });
    agent.prompt = vi.fn(async () => {
      setTimeout(() => cell.noteProviderStderrFailure({ message: 'Invalid API Key', signInRequired: true }), 50);
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'hi' });
    expect(cell.history().committed.at(-1)!.outcome).toEqual({
      kind: 'error',
      reason: 'prompt_failed',
      detail: 'Invalid API Key',
      signInRequired: true,
    });
    // 下一轮从干净的状态开始。
    agent.prompt = vi.fn(async () => {
      cell.push({ kind: 'message', role: 'assistant', messageId: null, text: 'ok' });
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'again' });
    expect(cell.history().committed.at(-1)!.outcome).toEqual({ kind: 'done', reason: 'end_turn' });
  });

  // #7103 谁拒绝谁说话:跑咕咕平台模型的这一轮来要票、咕咕没签出来。宿主在回绝取票**之前**把原因递进来
  // (announceSession → noteCredentialRefusal),所以 claude 报「apiKeyHelper is failing」之前它已经在这一轮手上。
  const APIKEY_HELPER_TEXT = "Your apiKeyHelper script is failing · This usually means you need to re-authenticate with your provider · Run /status to see the script's error output";

  it('咕咕拒了这一轮的票:按原因结算,claude 那句不进转录也不进详情', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { platformCredentials: true });
    agent.prompt = vi.fn(async () => {
      cell.noteCredentialRefusal('gugu-models:membership-required');
      cell.push({ kind: 'message', role: 'assistant', messageId: null, text: APIKEY_HELPER_TEXT });
      throw new Error('Internal error');
    });
    await cell.prompt({ text: 'hi' });
    const turn = cell.history().committed.at(-1)!;
    expect(turn.outcome).toEqual({ kind: 'error', reason: 'prompt_failed', guguReason: 'membership-required' });
    expect(JSON.stringify(turn.items)).not.toContain('apiKeyHelper');
  });

  it('咕咕拒了票、这一家却报成正常结束:同样按原因结算', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { platformCredentials: true });
    agent.prompt = vi.fn(async () => {
      cell.noteCredentialRefusal('gugu-models:signed-out');
      cell.push({ kind: 'message', role: 'assistant', messageId: null, text: APIKEY_HELPER_TEXT });
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'hi' });
    const turn = cell.history().committed.at(-1)!;
    expect(turn.outcome).toEqual({ kind: 'error', reason: 'prompt_failed', guguReason: 'signed-out' });
    expect(JSON.stringify(turn.items)).not.toContain('apiKeyHelper');
  });

  it('上一轮被拒、这一轮正常:这一轮的结算不带上一轮的原因,回复照常进转录', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { platformCredentials: true });
    agent.prompt = vi.fn(async () => {
      cell.noteCredentialRefusal('gugu-models:membership-required');
      throw new Error('Internal error');
    });
    await cell.prompt({ text: 'first' });
    expect(cell.history().committed.at(-1)!.outcome).toMatchObject({ guguReason: 'membership-required' });
    agent.prompt = vi.fn(async () => {
      cell.push({ kind: 'message', role: 'assistant', messageId: null, text: 'ok after membership' });
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'again' });
    const turn = cell.history().committed.at(-1)!;
    expect(turn.outcome).toEqual({ kind: 'done', reason: 'end_turn' });
    expect(JSON.stringify(turn.items)).toContain('ok after membership');
  });

  it('同一轮里后来签出来了(宿主递 null 撤掉):后面的回复照常进转录、照常结束', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { platformCredentials: true });
    agent.prompt = vi.fn(async () => {
      cell.noteCredentialRefusal('gugu-models:service-unavailable');
      cell.noteCredentialRefusal(null);
      cell.push({ kind: 'message', role: 'assistant', messageId: null, text: 'answer after retry' });
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'hi' });
    const turn = cell.history().committed.at(-1)!;
    expect(turn.outcome).toEqual({ kind: 'done', reason: 'end_turn' });
    expect(JSON.stringify(turn.items)).toContain('answer after retry');
  });

  it('[阴性对照] 不跑咕咕平台模型的会话:递进来的原因不改它的结局', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent);
    agent.prompt = vi.fn(async () => {
      cell.noteCredentialRefusal('gugu-models:membership-required');
      throw new Error('upstream said no');
    });
    await cell.prompt({ text: 'hi' });
    const outcome = cell.history().committed.at(-1)!.outcome;
    expect(outcome).toMatchObject({ kind: 'error', reason: 'prompt_failed' });
    expect(outcome).not.toHaveProperty('guguReason');
  });

  it('不在回合里递进来的原因不收(还在起的会话没有这一轮)', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { platformCredentials: true });
    cell.noteCredentialRefusal('gugu-models:membership-required');
    agent.prompt = vi.fn(async () => {
      cell.push({ kind: 'message', role: 'assistant', messageId: null, text: 'fine' });
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'hi' });
    expect(cell.history().committed.at(-1)!.outcome).toEqual({ kind: 'done', reason: 'end_turn' });
  });

  it('a stderr failure in a turn that did reply is not the swallowed kind: still done (复核 93)', async () => {
    // 例:MiMo 重试用完前打过一行 ERROR、随后这一轮照常答完 —— stderr 只认「一个字都没出就结束」的那一种。
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { turnFailure: { watchesStderr: true } });
    agent.prompt = vi.fn(async () => {
      cell.noteProviderStderrFailure({ message: 'Invalid API Key', signInRequired: true });
      cell.push({ kind: 'message', role: 'assistant', messageId: null, text: 'OK-mimocode' });
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'hi' });
    expect(cell.history().committed.at(-1)!.outcome).toEqual({ kind: 'done', reason: 'end_turn' });
  });

  it('a normal reply still settles as done', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { turnFailure: { fromAgentMessage: () => null, watchesStderr: true } });
    agent.prompt = vi.fn(async () => {
      cell.push({ kind: 'message', role: 'assistant', messageId: null, text: 'hello' });
      return { stopReason: 'end_turn' };
    });
    await cell.prompt({ text: 'hi' });
    expect(cell.history().committed.at(-1)!.outcome).toEqual({ kind: 'done', reason: 'end_turn' });
  });

  it('drops the replayed session-context block but keeps the user words (#6335)', () => {
    const { cell } = makeCell(new FakeAcpAgent());
    cell.beginReplay();
    cell.push({ kind: 'message', role: 'user', messageId: null, text: '<gugu_platform>You are participating…</gugu_platform>' });
    cell.push({ kind: 'message', role: 'user', messageId: null, text: 'hello PROBE-FIRST' });
    cell.push({ kind: 'message', role: 'assistant', messageId: null, text: 'ok-1' });
    cell.endReplay();
    const texts = JSON.stringify(cell.history());
    expect(texts).not.toContain('gugu_platform');
    expect(texts).toContain('hello PROBE-FIRST');
  });

  it('does not re-send an unchanged session context after a replay, but does send a changed one (#6335)', async () => {
    const context = '<gugu_platform>platform</gugu_platform>';
    for (const [replayed, expectSent] of [[context, false], ['<gugu_platform>old</gugu_platform>', true]] as const) {
      const agent = new FakeAcpAgent();
      const { cell } = makeCell(agent, { sessionContext: context });
      cell.beginReplay();
      cell.push({ kind: 'message', role: 'user', messageId: null, text: replayed });
      cell.endReplay();
      await cell.prompt({ text: 'next' });
      expect(JSON.stringify(agent.prompt.mock.calls[0]![0]).includes('platform</gugu_platform>') && JSON.stringify(agent.prompt.mock.calls[0]![0]).includes('>platform<')).toBe(expectSent);
    }
  });

  it('interrupt-at-tool-boundary: waits for the running tool, cancels, then sends the message as the next turn (#6335)', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { midTurnSteer: 'interrupt-at-tool-boundary' });
    let resolveFirst!: (value: { stopReason: 'cancelled' }) => void;
    agent.prompt = vi.fn(
      () => new Promise<{ stopReason: 'cancelled' }>((resolve) => { resolveFirst = resolve; })
    );
    agent.cancel = vi.fn(async () => { resolveFirst({ stopReason: 'cancelled' }); return {}; });

    const first = cell.prompt({ text: 'long task' });
    await flushDrains();
    const tool = { toolCallId: 'bash-1', title: 'sleep 8', toolKind: 'execute' as const, parentToolCallId: null, diffs: [], locations: [] };
    cell.push({ kind: 'tool_call', ...tool, status: 'in_progress' });

    const steer = await cell.prompt({ text: 'mid-turn message' }, { steerIfBusy: true });
    expect(steer).toEqual({ success: true, data: { queued: true, steered: true } });
    // 没有并发的第二条 session/prompt(那会让这一家断连),工具还在跑 ⇒ 还不打断。
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(agent.cancel).not.toHaveBeenCalled();

    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    cell.push({ kind: 'tool_update', ...tool, status: 'completed' });
    expect(agent.cancel).toHaveBeenCalledTimes(1);

    await first;
    await flushDrains();
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(agent.prompt.mock.calls[0]![0])).toContain('mid-turn message');
    // 这一轮不是用户停的:如实标成「为新消息停下」,界面据此不给「继续 / 丢弃」。
    expect(cell.history().committed[0]?.outcome).toEqual({ kind: 'cancelled', reason: 'interrupted_for_message' });
  });

  it('interrupt-at-tool-boundary: with no tool running it interrupts right away', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { midTurnSteer: 'interrupt-at-tool-boundary' });
    let resolveFirst!: (value: { stopReason: 'cancelled' }) => void;
    agent.prompt = vi.fn()
      .mockImplementationOnce(() => new Promise<{ stopReason: 'cancelled' }>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ stopReason: 'end_turn' });
    agent.cancel = vi.fn(async () => { resolveFirst({ stopReason: 'cancelled' }); return {}; });

    const first = cell.prompt({ text: 'thinking hard' });
    await flushDrains();
    const firstPrompt = agent.prompt;
    await cell.prompt({ text: 'stop and read this' }, { steerIfBusy: true });
    expect(agent.cancel).toHaveBeenCalledTimes(1);
    await first;
    await flushDrains();
    expect(firstPrompt).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(firstPrompt.mock.calls[1]![0])).toContain('stop and read this');
  });

  it('interrupt-at-tool-boundary: the user already pressed stop ⇒ the turn stays user-stopped, not "interrupted for a message"', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, { midTurnSteer: 'interrupt-at-tool-boundary' });
    let resolveFirst!: (value: { stopReason: 'cancelled' }) => void;
    agent.prompt = vi.fn()
      .mockImplementationOnce(() => new Promise<{ stopReason: 'cancelled' }>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ stopReason: 'end_turn' });
    agent.cancel = vi.fn(async () => ({}));

    const first = cell.prompt({ text: 'long task' });
    await flushDrains();
    const tool = { toolCallId: 'bash-1', title: 'sleep 8', toolKind: 'execute' as const, parentToolCallId: null, diffs: [], locations: [] };
    cell.push({ kind: 'tool_call', ...tool, status: 'in_progress' });
    await cell.prompt({ text: 'mid-turn message' }, { steerIfBusy: true });

    // 用户先点了停止,然后工具才跑完、插话才走到边界。
    await cell.cancel();
    cell.push({ kind: 'tool_update', ...tool, status: 'completed' });
    expect(agent.cancel).toHaveBeenCalledTimes(1);

    resolveFirst({ stopReason: 'cancelled' });
    await first;
    await flushDrains();
    expect(cell.history().committed[0]?.outcome).toEqual({ kind: 'cancelled', reason: 'cancelled' });
  });

  it('uses negotiated _session/steering and promptRequired for the native ACP lane', async () => {
    const agent = new FakeAcpAgent();
    agent.extMethod = vi.fn().mockResolvedValue({ outcome: 'injected' });
    const { cell } = makeCell(agent, { supportsSteering: true });
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn(
      () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; })
    );

    const first = cell.prompt({ text: 'first' });
    const steer = await cell.prompt({ text: 'mid-turn message' }, { steerIfBusy: true });

    expect(steer).toEqual({ success: true, data: { queued: false } });
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(agent.extMethod).toHaveBeenCalledWith('_session/steering', {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'mid-turn message' }],
      _meta: { steering: { idleBehavior: 'promptRequired', delivery: 'next' } },
    });
    expect(cell.sessionState.lifecycle).toBe('working');

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    expect(cell.sessionState.lifecycle).toBe('ready');
  });

  it('keeps a cell-inserted steering message in the active turn', async () => {
    const agent = new FakeAcpAgent();
    agent.extMethod = vi.fn().mockResolvedValue({ outcome: 'injected' });
    const { cell } = makeCell(agent, { supportsSteering: true });
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn(
      () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; })
    );

    const first = cell.prompt({ text: 'first' });
    await flushDrains();
    cell.push({
      kind: 'tool_call',
      toolCallId: 'bash-1',
      title: 'sleep 20',
      toolKind: 'execute',
      status: 'in_progress',
      parentToolCallId: null,
      diffs: [],
      locations: [],
    });

    await expect(cell.prompt({ text: 'add a marker' }, { steerIfBusy: true })).resolves.toMatchObject({
      success: true,
      data: { queued: false },
    });

    const active = cell.history().active;
    expect(active?.items.filter((item) => item.kind === 'message').map((item) => (item as { text: string }).text)).toEqual([
      'first',
      'add a marker',
    ]);
    expect(active?.items.some((item) => item.kind === 'execute-tool-call')).toBe(true);

    resolveFirst({ stopReason: 'end_turn' });
    await first;
  });

  it('falls back exactly once through standard session/prompt when steering returns promptRequired', async () => {
    const agent = new FakeAcpAgent();
    agent.extMethod = vi.fn().mockResolvedValue({ outcome: 'promptRequired' });
    const { cell } = makeCell(agent, { supportsSteering: true });
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; })
      )
      .mockResolvedValue({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // #6823 忙时插话只来自投递,来路由投递方带着(运行时入口都要求来路,这里不再替它补)。
    const steer = await cell.prompt({ text: 'mid-turn message', origin: 'communication' }, { steerIfBusy: true });

    expect(steer).toEqual({ success: true, data: { queued: true } });
    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();
    expect(agent.extMethod).toHaveBeenCalledTimes(1);
    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect((agent.prompt as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({
      prompt: [{ type: 'text', text: 'mid-turn message' }],
    });
  });

  it('retains an admitted communication steer across repeated provider token-boundary failures', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; })
      )
      .mockRejectedValueOnce(new Error('Invalid token'))
      .mockRejectedValueOnce(new Error('Invalid token'))
      .mockResolvedValueOnce({ stopReason: 'end_turn' })
      .mockRejectedValueOnce(new Error('Invalid token'))
      .mockResolvedValueOnce({ stopReason: 'end_turn' })
      .mockResolvedValueOnce({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'busy', origin: 'typed' });
    const steer = cell.prompt(
      { text: '<gugu_delivery from="sender"/>', origin: 'communication' },
      { steerIfBusy: true },
    );
    await flushDrains();

    await expect(steer).resolves.toMatchObject({
      success: true,
      data: { queued: true, requeuedAfterTokenBoundary: true },
    });
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual([
      '<gugu_delivery from="sender"/>',
    ]);

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();

    expect(agent.prompt).toHaveBeenCalledTimes(3);
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual([
      '<gugu_delivery from="sender"/>',
    ]);
    expect(cell.sessionState.lastTurnOutcome).toBe('stopped');

    await cell.prompt({ text: 'boundary-2', origin: 'typed' });
    await flushDrains();
    expect(agent.prompt).toHaveBeenCalledTimes(5);
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual([
      '<gugu_delivery from="sender"/>',
    ]);
    expect(cell.sessionState.lastTurnOutcome).toBe('stopped');

    await cell.prompt({ text: 'boundary-3', origin: 'typed' });
    await flushDrains();
    expect(agent.prompt).toHaveBeenCalledTimes(7);
    expect((agent.prompt as ReturnType<typeof vi.fn>).mock.calls[6][0].prompt).toEqual([
      { type: 'text', text: '<gugu_delivery from="sender"/>' },
    ]);
    expect(cell.sessionState.queuedPrompts).toEqual([]);
    const communicationMessages = cell.history().committed
      .flatMap((turn) => turn.items)
      .filter((item) => item.kind === 'message' && item.role === 'user' && item.text === '<gugu_delivery from="sender"/>');
    expect(communicationMessages).toHaveLength(1);
  });

  // 跨家读数(#4472 comment-5464601764:qwen 3/3 主 RPC cancelled 而工作照常、steer end_turn 收尾;
  // droid 同形):并发 steer 引发的主 RPC cancelled 不是真取消,结算权移交给 steer。
  it('hands settlement to the steer when the primary reports a concurrency-induced cancelled (qwen/droid shape)', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: string }) => void;
    let resolveSteer!: (value: { stopReason: string }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSteer = resolve; }));

    const first = cell.prompt({ text: 'first' });
    const steer = cell.prompt({ text: 'mid-turn message' }, { steerIfBusy: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    resolveFirst({ stopReason: 'cancelled' });
    await first;
    // 一轮活着的对话不落 cancelled 终态:turn 仍在飞,等 steer 的 RPC 收尾。
    expect(cell.sessionState.lifecycle).toBe('working');
    expect(cell.sessionState.lastStopReason).toBeNull();

    resolveSteer({ stopReason: 'end_turn' });
    await steer;
    expect(cell.sessionState.lifecycle).toBe('ready');
    expect(cell.sessionState.lastStopReason).toBe('end_turn');
  });

  it('still settles a REAL cancellation immediately even with a steer in flight (own Cancel is the discriminator)', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: string }) => void;
    let resolveSteer!: (value: { stopReason: string }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSteer = resolve; }));

    const first = cell.prompt({ text: 'first' });
    const steer = cell.prompt({ text: 'mid-turn message' }, { steerIfBusy: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await cell.cancel();
    resolveFirst({ stopReason: 'cancelled' });
    await first;
    // 我们自己发的 Cancel ⇒ cancelled 是真取消,立即结算,❌ 不被移交守卫吞掉。
    expect(cell.sessionState.lifecycle).toBe('ready');
    expect(cell.sessionState.lastStopReason).toBe('cancelled');

    resolveSteer({ stopReason: 'end_turn' });
    await steer;
    expect(cell.sessionState.lifecycle).toBe('ready');
  });

  // #6448 park 照收投递(owner 定):只剩后台子代理在跑时没有回合在飞,新来的一句当场开一轮,
  // ❌ 排到后台跑完(从前这里断言的正是那条排队)。后台子代理照跑,不被这一轮打断。
  it('starts a new turn for a prompt that arrives while only background agents run', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    cell.push({
      kind: 'subagent',
      toolCallId: 'tool-1',
      agentId: 'agent-1',
      title: 'Background agent',
      status: 'in_progress',
      parentToolCallId: null,
      background: true,
    });
    expect(cell.sessionState.backgroundAgentCount).toBe(1);

    const sent = await cell.prompt({ text: 'while parked', origin: 'typed' });
    expect(sent).toEqual({ success: true, data: { queued: false } });
    expect(agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'while parked' }],
    });
    expect(cell.sessionState.queuedPrompts).toHaveLength(0);
    expect(cell.sessionState.backgroundAgentCount, 'the background agent keeps running').toBe(1);
  });

  // ACP v2:父回合在自己的结果处结束,有自己会话的子智能体照跑,它的结局由它自己报。
  it('keeps a subagent with its own session running past the end of the turn that launched it', async () => {
    const { cell, agent } = makeCell();
    let resolvePrompt!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn(
      () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolvePrompt = resolve; })
    );
    const sent = cell.prompt({ text: 'launch a child', origin: 'typed' });
    cell.push({
      kind: 'subagent',
      toolCallId: 'child-1',
      subagentSessionId: 'child-1',
      title: 'general-purpose',
      status: 'in_progress',
      parentToolCallId: null,
      canCancel: true,
    });
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalled());
    resolvePrompt({ stopReason: 'end_turn' });
    await sent;

    expect(cell.sessionState.lifecycle).toBe('ready');
    expect(cell.transcript.agents.find((a) => a.agentId === 'child-1')?.status).toBe('running');
    expect(cell.sessionState.backgroundAgentCount).toBe(1);

    cell.push({ kind: 'subagent_done', toolCallId: 'child-1', agentId: 'child-1', subagentSessionId: 'child-1', status: 'completed' });
    expect(cell.transcript.agents.find((a) => a.agentId === 'child-1')?.status).toBe('completed');
  });

  // #6448 Claude 的 `run_in_background` Bash 不挂住回合:轮当场收口、命令还在跑。状态要数到它(park),
  // 但它不让会话变忙、也不开取消 —— 命令在自己的卡上停。事件序列照真机:spawned 不带归属,progress 才带(#5117)。
  it('counts a background command that outlives its turn, without making the session busy', async () => {
    const { cell, agent } = makeCell();
    let resolvePrompt!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn(
      () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolvePrompt = resolve; })
    );

    const turn = cell.prompt({ text: 'run it in the background' });
    await flushDrains();
    cell.push({
      kind: 'tool_call',
      toolCallId: 'bash-1',
      title: 'sleep 60',
      toolKind: 'execute',
      status: 'completed',
      parentToolCallId: null,
      diffs: [],
      locations: [],
    });
    cell.push({
      kind: 'async_task',
      asyncTaskId: 'task-1',
      name: 'sleep 60',
      taskType: 'local_bash',
      description: 'sleep 60',
      showInTranscript: true,
      canStop: true,
    });
    expect(cell.sessionState.backgroundCommandCount, 'no owner yet: not counted').toBe(0);
    cell.push({ kind: 'async_task_progress', asyncTaskId: 'task-1', toolCallId: 'bash-1' });
    expect(cell.sessionState.backgroundCommandCount).toBe(1);
    // #6582 面板花名册按这组 id 筛:数目就是它的长度,两者同源。
    expect(cell.sessionState.backgroundCommandTaskIds).toEqual(['task-1']);

    resolvePrompt({ stopReason: 'end_turn' });
    await turn;
    expect(cell.sessionState).toMatchObject({
      lifecycle: 'ready',
      backgroundCommandCount: 1,
      backgroundAgentCount: 0,
      isGenerating: false,
      canCancel: false,
    });

    cell.push({ kind: 'async_task_state', asyncTaskId: 'task-1', state: 'running' });
    expect(cell.sessionState.backgroundCommandCount, 'running is still running').toBe(1);
    cell.push({ kind: 'async_task_state', asyncTaskId: 'task-1', state: 'completed', summary: 'done' });
    expect(cell.sessionState.backgroundCommandCount).toBe(0);
    expect(cell.sessionState.backgroundCommandTaskIds).toEqual([]);
  });

  it('does not count a background command replayed from an earlier process', () => {
    const { cell } = makeCell();
    cell.beginReplay();
    cell.push({
      kind: 'tool_call',
      toolCallId: 'bash-1',
      title: 'sleep 3000',
      toolKind: 'execute',
      status: 'completed',
      parentToolCallId: null,
      diffs: [],
      locations: [],
    });
    cell.push({ kind: 'async_task_progress', asyncTaskId: 'task-1', toolCallId: 'bash-1' });
    cell.endReplay();
    expect(JSON.stringify(cell.transcript.history), 'the replayed card does carry the task id').toContain('"backgroundTaskId":"task-1"');
    expect(cell.sessionState.backgroundCommandCount).toBe(0);
    // #6582 上一个进程起的命令不在这组 id 里 ⇒ 面板上库里那张同名卡也被筛掉。
    expect(cell.sessionState.backgroundCommandTaskIds).toEqual([]);
  });

  it('still cancels background agents from park', async () => {
    const { cell, agent } = makeCell();
    cell.push({
      kind: 'subagent',
      toolCallId: 'tool-1',
      agentId: 'agent-1',
      title: 'Background agent',
      status: 'in_progress',
      parentToolCallId: null,
      background: true,
    });

    await cell.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.cancel).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(cell.transcript.agents).toMatchObject([{ agentId: 'agent-1', status: 'failed' }]);
    expect(cell.sessionState.backgroundAgentCount).toBe(0);
  });
});

describe('SessionCell permissions', () => {
  it('brokers permission requests through the per-cell broker', async () => {
    const { cell } = makeCell();
    const permission = cell.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Read a file', kind: 'read' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as PermissionOptionKind }],
    });

    expect(cell.sessionState.pendingPermissions).toHaveLength(1);
    expect(cell.sessionState.pendingPermissions[0].toolCall).toMatchObject({
      kind: 'read-tool-call',
      toolCallId: 'tool-1',
    });

    const result = cell.resolvePermission(
      cell.sessionState.pendingPermissions[0].requestId,
      'allow'
    );
    expect(isOk(result)).toBe(true);
    await expect(permission).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(cell.sessionState.pendingPermissions).toHaveLength(0);
  });

  it('keeps the rawInput of a request that names no call in the turn (a Codex MCP approval, #6900)', () => {
    const { cell } = makeCell();
    void cell.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'item-9:ask:mcp-elicitation:4', title: 'mcp__l3dice__roll', rawInput: { sides: 20 } },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as PermissionOptionKind }],
    });

    expect(cell.sessionState.pendingPermissions[0].toolCall).toMatchObject({
      kind: 'mcp-tool-call',
      server: 'l3dice',
      tool: 'roll',
      rawInput: JSON.stringify({ sides: 20 }, null, 2),
    });
    cell.dispose();
  });

  it('drains pending permissions on dispose', async () => {
    const { cell } = makeCell();
    const permission = cell.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-2', title: 'Write a file', kind: 'edit' },
      options: [
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' as PermissionOptionKind },
      ],
    });

    cell.dispose();

    await expect(permission).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  const shellRequest = (toolCallId: string, kinds: string[]) => ({
    sessionId: 'session-1',
    toolCall: { toolCallId, title: 'Run a command', kind: 'execute' as const },
    options: kinds.map((kind) => ({
      optionId: kind.replace('_', '-'),
      name: kind,
      kind: kind as PermissionOptionKind,
    })),
  });

  it('answers a full-access session by standard kind without leaving a pending request', async () => {
    const { cell } = makeCell(new FakeAcpAgent(), { autoApprovePermissions: true });
    const permission = cell.requestPermission(
      shellRequest('tool-auto', ['allow_always', 'allow_once', 'reject_once'])
    );

    await expect(permission).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(cell.sessionState.pendingPermissions).toHaveLength(0);
  });

  it('falls to allow_always only when the request offers no allow_once', async () => {
    const { cell } = makeCell(new FakeAcpAgent(), { autoApprovePermissions: true });
    await expect(
      cell.requestPermission(shellRequest('tool-always', ['allow_always', 'reject_once']))
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-always' } });
  });

  it('never answers a question or plan approval on the user\'s behalf, even in full access', async () => {
    const { cell } = makeCell(new FakeAcpAgent(), { autoApprovePermissions: true });
    void cell.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-plan', title: 'ExitPlanMode', kind: 'switch_mode' },
      options: [
        { optionId: 'default', name: 'Yes', kind: 'allow_once' as PermissionOptionKind },
        { optionId: 'plan', name: 'Keep planning', kind: 'reject_once' as PermissionOptionKind },
      ],
    });
    expect(cell.sessionState.pendingPermissions).toHaveLength(1);
  });

  // #6448 / 研究 03 gap 4:pi-acp 把 pi 的 `select` 发成全是 `allow_once` 的 `choice-N`;完全访问档从前拿
  // `choice-0` 替用户答了这道题。判据是请求的结构(一个选项都拒绝不了 = 让人挑一个,不是批准),❌ 看标题文案。
  it('never answers a choose-one request (no refusal option) for the user, even in full access', async () => {
    const { cell } = makeCell(new FakeAcpAgent(), { autoApprovePermissions: true });
    void cell.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'pi-ui-7', title: 'Pick a deployment target', kind: 'other' },
      options: [
        { optionId: 'choice-0', name: 'staging', kind: 'allow_once' as PermissionOptionKind },
        { optionId: 'choice-1', name: 'production', kind: 'allow_once' as PermissionOptionKind },
      ],
    });
    expect(cell.sessionState.pendingPermissions).toHaveLength(1);
  });

  it('never fails a question whose options carry no standard kind (codex requestUserInput) in full access', async () => {
    const { cell } = makeCell(new FakeAcpAgent(), { autoApprovePermissions: true });
    const answer = cell.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'item-1:ask:q1', title: 'Which approach?' },
      options: [
        { optionId: '0', name: 'A', kind: 'other' as PermissionOptionKind },
        { optionId: '1', name: 'B', kind: 'other' as PermissionOptionKind },
      ],
    });
    expect(cell.sessionState.pendingPermissions).toHaveLength(1);
    cell.resolvePermission(cell.sessionState.pendingPermissions[0].requestId, '1');
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'selected', optionId: '1' } });
  });

  it('fails loudly when a full-access session gets no standard allow option', async () => {
    const { cell } = makeCell(new FakeAcpAgent(), { autoApprovePermissions: true });
    await expect(
      cell.requestPermission(shellRequest('tool-none', ['reject_once']))
    ).rejects.toMatchObject({ name: 'AcpPermissionResolutionError' });
    expect(cell.sessionState.pendingPermissions).toHaveLength(0);
  });

  it('follows a live permission change in both directions', async () => {
    const { cell, agent } = makeCell(new FakeAcpAgent(), {
      autoApprovePermissions: false,
      permissionModeMap: { edit: { id: 'agent' }, 'full-access': { id: 'agent-full-access' } },
    });
    const modeConfig = (currentValue: string) => ({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode' as const,
          type: 'select' as const,
          currentValue,
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'agent-full-access', name: 'Agent (full access)' },
          ],
        },
      ],
    });
    cell.applySessionMeta(modeConfig('agent'));

    // 受限档:进待决,等人点(阳性对照 —— 同一个 cell、同一种请求)。
    void cell.requestPermission(shellRequest('tool-before', ['allow_once']));
    expect(cell.sessionState.pendingPermissions).toHaveLength(1);
    cell.resolvePermission(cell.sessionState.pendingPermissions[0].requestId, 'allow-once');

    agent.setSessionConfigOption = vi.fn().mockResolvedValue(modeConfig('agent-full-access'));
    expect(isOk(await cell.setMode('agent-full-access'))).toBe(true);
    await expect(
      cell.requestPermission(shellRequest('tool-up', ['allow_once']))
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(cell.sessionState.pendingPermissions).toHaveLength(0);

    agent.setSessionConfigOption = vi.fn().mockResolvedValue(modeConfig('agent'));
    expect(isOk(await cell.setMode('agent'))).toBe(true);
    void cell.requestPermission(shellRequest('tool-down', ['allow_once']));
    expect(cell.sessionState.pendingPermissions).toHaveLength(1);
  });

  it('keeps full access when startup lands on a provider mode that cannot express it', async () => {
    const { cell, agent } = makeCell(new FakeAcpAgent(), {
      autoApprovePermissions: true,
      permissionModeMap: { edit: { id: 'agent' } },
    });
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'plan',
          options: [
            { value: 'plan', name: 'Plan' },
            { value: 'agent', name: 'Agent' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'plan', name: 'Plan' },
            { value: 'agent', name: 'Agent' },
          ],
        },
      ],
    });
    expect(isOk(await cell.setMode('agent', { startupOnly: true }))).toBe(true);
    await expect(
      cell.requestPermission(shellRequest('tool-startup', ['allow_once']))
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  // #7139 qwen 0.22.3:流里那一行(准备帧)rawInput 是 `{}`,计划只在审批请求的 rawInput.plan 与正文里。
  const PLAN = '# Plan\n1. write notes.txt';
  const qwenPlanRequest = {
    sessionId: 'session-1',
    toolCall: {
      toolCallId: 'call-plan',
      status: 'pending' as const,
      title: 'Plan:',
      kind: 'switch_mode' as const,
      rawInput: { plan: PLAN },
      content: [{ type: 'content' as const, content: { type: 'text' as const, text: PLAN } }],
      _meta: { toolName: 'exit_plan_mode' },
    },
    options: [
      { optionId: 'restore_previous', name: 'Yes, restore previous mode (default)', kind: 'allow_once' as PermissionOptionKind },
      { optionId: 'cancel', name: 'No, keep planning (esc)', kind: 'reject_once' as PermissionOptionKind },
    ],
  };

  it('fills the stream row with the plan only the approval request carries, and the committed turn keeps it (#7139)', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent);
    let endTurn!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn(() => new Promise<{ stopReason: 'end_turn' }>((resolve) => { endTurn = resolve; }));
    const turn = cell.prompt({ text: 'plan it' });
    await flushDrains();
    cell.push({
      kind: 'tool_call', toolCallId: 'call-plan', title: 'ExitPlanMode', toolName: 'exit_plan_mode', toolKind: 'switch_mode',
      status: 'pending', parentToolCallId: null, diffs: [], locations: [], rawInput: '{}',
    });

    void cell.requestPermission(qwenPlanRequest);
    const pending = cell.sessionState.pendingPermissions[0];
    expect(JSON.parse(pending.toolCall.rawInput ?? 'null')).toEqual({ plan: PLAN });
    expect(permissionWaitKind(pending)).toBe('plan');

    cell.resolvePermission(pending.requestId, 'cancel');
    endTurn({ stopReason: 'end_turn' });
    await turn;
    // 提交的这一轮就是存库、重开会话读回来的那份:正文还在。
    const reopened = JSON.parse(JSON.stringify(cell.history().committed.at(-1)));
    const row = reopened.items.find((item: { toolCallId?: string }) => item.toolCallId === 'call-plan');
    expect(JSON.parse(row.rawInput)).toEqual({ plan: PLAN });
    expect(row.outputText).toBe(PLAN);
  });

  it('does not overwrite what the stream row already has', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent);
    agent.prompt = vi.fn(() => new Promise(() => {}));
    void cell.prompt({ text: 'plan it' });
    await flushDrains();
    cell.push({
      kind: 'tool_call', toolCallId: 'call-plan', title: 'Approve Plan', toolName: 'ExitPlanMode', toolKind: 'switch_mode',
      status: 'pending', parentToolCallId: null, diffs: [], locations: [], rawInput: '{"plan":"from the stream"}', outputText: 'stream text',
    });

    void cell.requestPermission(qwenPlanRequest);
    const row = cell.sessionState.pendingPermissions[0].toolCall;
    expect(row.rawInput).toBe('{"plan":"from the stream"}');
    expect(row.outputText).toBe('stream text');
    expect(row.toolName).toBe('ExitPlanMode');
    cell.dispose();
  });

  // qoder 1.1.71:工具名在 `_meta.qoder.toolName`,标题是一句话。请求先到、流里还没有这一行时也认得出是计划审批,
  // 完全访问档就不替人批。
  it('names a request that arrives before its row from the vendor _meta, so full access leaves the plan to the user', () => {
    const { cell } = makeCell(new FakeAcpAgent(), { autoApprovePermissions: true });
    void cell.requestPermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'qoder-plan', title: 'Ready to start implementation?', kind: 'other',
        content: [{ type: 'content', content: { type: 'text', text: PLAN } }],
        _meta: { qoder: { toolName: 'ExitPlanMode' } },
      },
      options: [
        { optionId: 'default', name: 'Yes, and manually approve edits', kind: 'allow_once' as PermissionOptionKind },
        { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' as PermissionOptionKind },
      ],
    });
    const pending = cell.sessionState.pendingPermissions;
    expect(pending).toHaveLength(1);
    expect(pending[0].toolCall.toolName).toBe('ExitPlanMode');
    expect(permissionWaitKind(pending[0])).toBe('plan');
    cell.dispose();
  });

  // 复核 1e482ff8:请求先到、流里那一行后到(qoder 契约测试就是这个次序)——那一行带着 `{}` 到时，照待批的请求补。
  it('fills the row that arrives after its request from the pending request', async () => {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent);
    agent.prompt = vi.fn(() => new Promise(() => {}));
    void cell.prompt({ text: 'plan it' });
    await flushDrains();
    void cell.requestPermission({
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'qoder-plan', title: 'Ready to start implementation?', kind: 'other',
        content: [{ type: 'content', content: { type: 'text', text: PLAN } }],
        _meta: { qoder: { toolName: 'ExitPlanMode' } },
      },
      options: [{ optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' as PermissionOptionKind }],
    });
    cell.push({
      kind: 'tool_call', toolCallId: 'qoder-plan', title: 'Ready to start implementation?', toolKind: 'other',
      status: 'pending', parentToolCallId: null, diffs: [], locations: [], rawInput: '{}',
    });

    const row = cell.transcript.activeTurn?.items.find((item) => 'toolCallId' in item && item.toolCallId === 'qoder-plan');
    expect(row).toMatchObject({ outputText: PLAN, toolName: 'ExitPlanMode' });
    cell.dispose();
  });
});

describe('SessionCell config options', () => {
  it('fails loudly when the provider omits the live settings declaration', async () => {
    const { cell } = makeCell(new FakeAcpAgent(), { liveSettings: undefined });

    const result = await cell.setConfigOption('model', 'model-b');

    expect(result).toMatchObject({
      success: false,
      error: { type: 'set_config_failed', cause: { name: 'LiveSettingUndeclared' } },
    });
  });

  /**
   * 三维各自声明:声明了模型、没声明权限的家,改权限仍然响亮拒,且说出是哪一维(#6182 copilot / qwen)。
   */
  it('rejects an undeclared dimension even when another dimension is declared', async () => {
    const { cell } = makeCell(new FakeAcpAgent(), {
      liveSettings: { model: TEST_LIVE_SETTINGS.model },
    });

    const result = await cell.setConfigOption('effort', 'high');

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'set_config_failed',
        cause: { name: 'LiveSettingUndeclared', message: expect.stringContaining('live effort setting') },
      },
    });
  });

  /**
   * copilot 走自定义 provider 时 `configOptions` 里没有 `model`,却收 `set_config_option {configId:'model'}`
   * (#6182 实测)。声明出来的 configId 必须同时进状态机的「认得的 id」和真正发出去的请求 ——
   * 两处取值分叉的话,要么状态机当场拒(`Config option 'model' is not known`),要么发出去一个空 id。
   */
  it('writes a declared config id the provider accepts but never advertises', async () => {
    const { cell, agent } = makeCell(new FakeAcpAgent(), {
      liveSettings: {
        model: {
          channel: 'acp-config-option',
          configId: 'model',
          ack: 'ack',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'none',
        },
      },
    });
    cell.applySessionMeta({
      configOptions: [{
        id: 'allow_all',
        name: 'Allow All',
        category: 'permissions',
        type: 'select',
        currentValue: 'off',
        options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }],
      }],
    });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [{
        id: 'allow_all',
        name: 'Allow All',
        category: 'permissions',
        type: 'select',
        currentValue: 'off',
        options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }],
      }],
    });

    const result = await cell.setConfigOption('model', 'glm-5.3-flash');

    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1', configId: 'model', value: 'glm-5.3-flash',
    });
    expect(result).toEqual({
      success: true,
      data: { status: 'applied', effectiveValue: 'glm-5.3-flash', channel: 'acp-config-option' },
    });
  });

  it('an acked session/set_mode moves the selected mode, at startup and later, for a provider that sends no current_mode_update', async () => {
    const liveSettings = {
      permission: { channel: 'acp-mode', ack: 'ack', busy: 'reject', reloadRequired: false, recovery: 'none' },
    } as const satisfies LiveSettingsCapability;
    const { cell, agent } = makeCell(new FakeAcpAgent(), { providerId: 'hermes', liveSettings });
    cell.applySessionMeta({
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'accept_edits', name: 'Accept edits' },
          { id: 'dont_ask', name: "Don't ask" },
        ],
      },
    });
    expect(cell.config.modeOptions?.selected).toBe('default');

    expect(await cell.setMode('dont_ask', { startupOnly: true })).toMatchObject({ success: true });
    expect(agent.setSessionMode).toHaveBeenCalledWith({ sessionId: 'session-1', modeId: 'dont_ask' });
    expect(cell.config.modeOptions?.selected).toBe('dont_ask');

    expect(await cell.setMode('accept_edits')).toMatchObject({ success: true, data: { status: 'applied', channel: 'acp-mode' } });
    expect(cell.config.modeOptions?.selected).toBe('accept_edits');
  });

  it('fails loudly when a config setter is not exposed', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'model-a',
        options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }],
      }],
    });
    agent.setSessionConfigOption = undefined as unknown as typeof agent.setSessionConfigOption;

    const result = await cell.setConfigOption('model', 'model-b');

    expect(result).toMatchObject({
      success: false,
      error: { type: 'set_config_failed', cause: { name: 'LiveSettingExecutorMissing' } },
    });
    expect(cell.config.modelOptions?.selected).toBe('model-a');
  });

  it('applies a queue-next-turn mutation while the current turn is still in flight', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'model-a',
        options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }],
      }],
    });
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ stopReason: 'end_turn' });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'model-b',
        options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }],
      }],
    });

    const first = cell.prompt({ text: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstEnvelope = cell.turnEnvelope;
    const mutation = cell.setConfigOption('model', 'model-b');
    const queued = await cell.prompt({ text: 'second', origin: 'typed' });

    expect(firstEnvelope).toMatchObject({ model: 'model-a', turnSequence: 1 });
    expect(queued).toEqual({ success: true, data: { queued: true } });
    expect(cell.turnEnvelope).toEqual(firstEnvelope);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1', configId: 'model', value: 'model-b',
    });
    expect(cell.turnEnvelope).toEqual(firstEnvelope);

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await mutation;
    await flushDrains();

    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect(cell.turnEnvelope).toMatchObject({ model: 'model-b', turnSequence: 2 });
  });

  it('rejects a live mutation while a busy=reject turn is in flight', async () => {
    const { cell, agent } = makeCell(new FakeAcpAgent(), {
      liveSettings: {
        model: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'none',
        },
        permission: {
          channel: 'unsupported',
          ack: 'none',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'unsupported',
        },
        effort: {
          channel: 'unsupported',
          ack: 'none',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'unsupported',
        },
      },
    });
    cell.applySessionMeta({
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'model-a',
        options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }],
      }],
    });
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn().mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    agent.setSessionConfigOption = vi.fn();

    const first = cell.prompt({ text: 'first', origin: 'typed' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(cell.setConfigOption('model', 'model-b')).resolves.toMatchObject({
      success: false,
      error: { type: 'set_config_failed', cause: { name: 'LiveSettingBusy' } },
    });
    expect(agent.setSessionConfigOption).not.toHaveBeenCalled();

    resolveFirst({ stopReason: 'end_turn' });
    await first;
  });

  /**
   * 一条生产会话（0.2.46，真实用户）因为这条判据整条打不开：用户选的 `opus` 被 claude 的 ACP
   * 适配器规范化成它目录里的正式写法 `opus[1m]`，模型一字不差地换对了，而咕咕拿
   * 「我发出去的字 === 我读回来的字」当判据，把这次成功判成失败并杀掉了会话启动。
   *
   * 实测 claude 2.1.266 + `@agentclientprotocol/claude-agent-acp` 0.75.1：
   *   目录 = ["default","opus[1m]","claude-fable-5-1[1m]","sonnet","haiku"]（**没有**裸 `opus`）
   *   set `opus`            → 不抛错，回读 `opus[1m]`
   *   set `claude-sonnet-5` → 不抛错，回读 `sonnet`
   *   set `claude-opus-4-8` → 抛 `Invalid value for config option model`（真的用不了是抛错，
   *                            ❌ 不是静默回读成别的）
   * 适配器源码原话：「Use the canonical option value so downstream code always receives the
   * model ID rather than the caller-supplied alias.」——它是**故意**这么做的。
   */
  it('accepts the provider canonical spelling when the requested id is not in its own catalog', async () => {
    const { cell, agent } = makeCell(new FakeAcpAgent(), {
      liveSettings: {
        model: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
        },
        permission: {
          channel: 'unsupported',
          ack: 'none',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'unsupported',
        },
        effort: {
          channel: 'unsupported',
          ack: 'none',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'unsupported',
        },
      },
    });
    const catalog = (currentValue: string) => [{
      id: 'model',
      name: 'Model',
      category: 'model' as const,
      type: 'select' as const,
      currentValue,
      // 裸 `opus` 不在目录里 —— 这正是适配器要去解析别名的原因。
      options: [
        { value: 'default', name: 'Default' },
        { value: 'opus[1m]', name: 'Opus' },
        { value: 'sonnet', name: 'Sonnet' },
      ],
    }];
    cell.applySessionMeta({ configOptions: catalog('default') });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({ configOptions: catalog('opus[1m]') });

    const result = await cell.setConfigOption('model', 'opus');

    expect(result).toMatchObject({ success: true });
    expect(result.success && result.data).toMatchObject({
      status: 'applied',
      effectiveValue: 'opus[1m]',
    });
    // 别名被翻成正式写法不是「替换」——跑的就是用户要的那个东西，说出来只是噪音。
    expect(result.success && (result.data as { substituted?: string }).substituted).toBeUndefined();
  });

  /**
   * 反过来的那一半：我们请求的值 provider 目录里**确实有**，它却停在别处 ⇒ 用户选的和实际在跑的
   * 不是一个东西。会话照常可用（❌ 不再失败），但这件事必须留下可诊断的痕迹
   * （spec `session-history-replay`：截断与失败都要留下可诊断的痕迹）。
   */
  it('marks a substitution when the provider had the requested id on offer and stayed elsewhere', async () => {
    const { cell, agent } = makeCell(new FakeAcpAgent(), {
      liveSettings: {
        model: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
        },
        permission: {
          channel: 'unsupported',
          ack: 'none',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'unsupported',
        },
        effort: {
          channel: 'unsupported',
          ack: 'none',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'unsupported',
        },
      },
    });
    const catalog = (currentValue: string) => [{
      id: 'model',
      name: 'Model',
      category: 'model' as const,
      type: 'select' as const,
      currentValue,
      options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }],
    }];
    cell.applySessionMeta({ configOptions: catalog('model-a') });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({ configOptions: catalog('model-a') });

    const result = await cell.setConfigOption('model', 'model-b');

    expect(result).toMatchObject({ success: true });
    expect(result.success && result.data).toMatchObject({
      status: 'applied',
      effectiveValue: 'model-a',
      substituted: 'model-b',
    });
  });

  it('does not send the next turn when the provider does not confirm a queued mutation', async () => {
    const { cell, agent } = makeCell(new FakeAcpAgent(), {
      liveSettings: {
        model: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'queue-next-turn',
          reloadRequired: false,
          recovery: 'none',
        },
        permission: {
          channel: 'unsupported',
          ack: 'none',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'unsupported',
        },
        effort: {
          channel: 'unsupported',
          ack: 'none',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'unsupported',
        },
      },
    });
    cell.applySessionMeta({
      configOptions: [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'model-a',
        options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }],
      }],
    });
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn().mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({});

    const first = cell.prompt({ text: 'first', origin: 'typed' });
    const mutation = cell.setConfigOption('model', 'model-b');
    await cell.prompt({ text: 'second', origin: 'typed' });
    resolveFirst({ stopReason: 'end_turn' });
    await first;

    await expect(mutation).resolves.toMatchObject({
      success: false,
      error: { type: 'set_config_failed', cause: { name: 'LiveSettingReadBackMissing' } },
    });
    await flushDrains();
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(cell.sessionState.queuedPrompts).toHaveLength(1);
    expect(cell.liveSettingBlock).toMatch(/did not confirm/);
  });

  it('returns an explicit restart requirement for a provider without a live channel', async () => {
    const { cell, agent } = makeCell(new FakeAcpAgent(), {
      liveSettings: {
        model: {
          channel: 'reload-session',
          ack: 'none',
          busy: 'reject',
          reloadRequired: true,
          recovery: 'runtime-restart',
        },
        permission: {
          channel: 'unsupported',
          ack: 'none',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'unsupported',
        },
        effort: {
          channel: 'unsupported',
          ack: 'none',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'unsupported',
        },
      },
    });
    const result = await cell.setConfigOption('model', 'model-b');

    expect(result).toEqual({
      success: true,
      data: { status: 'restart_required', requestedValue: 'model-b', channel: 'reload-session' },
    });
    expect(agent.setSessionConfigOption).not.toHaveBeenCalled();
    expect(cell.liveSettingBlock).toMatch(/not confirmed/);
  });

  it('fails loudly and keeps the current model when the provider rejects an unknown value', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-5.6-sol',
          options: [
            { value: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
            { value: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = vi.fn().mockRejectedValue(new Error('model not in allowlist: gpt-9'));

    const result = await cell.setConfigOption('model', 'gpt-9');

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'set_config_failed',
        cause: { message: 'model not in allowlist: gpt-9' },
      },
    });
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'model',
      value: 'gpt-9',
    });
    expect(cell.config.modelOptions?.selected).toBe('gpt-5.6-sol');
  });

  it('sets mode through the provider config option and seeds the response', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'agent-full-access', name: 'Agent (full access)' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent-full-access',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'agent-full-access', name: 'Agent (full access)' },
          ],
        },
      ],
    });

    const result = await cell.setMode('agent-full-access');

    expect(isOk(result)).toBe(true);
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'mode',
      value: 'agent-full-access',
    });
    expect(agent.setSessionMode).not.toHaveBeenCalled();
    expect(cell.config.modeOptions?.selected).toBe('agent-full-access');
  });

  it('falls back to setSessionMode when config updates are unavailable', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [
            { value: 'agent', name: 'Agent' },
            { value: 'read-only', name: 'Read-only' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = undefined as unknown as typeof agent.setSessionConfigOption;

    const result = await cell.setMode('read-only');

    expect(isOk(result)).toBe(true);
    expect(agent.setSessionMode).toHaveBeenCalledWith({
      sessionId: 'session-1',
      modeId: 'read-only',
    });
  });

  it('resolves effort dimension to the provider config option id', async () => {
    const { cell, agent } = makeCell();
    cell.applySessionMeta({
      configOptions: [
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    });
    agent.setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: [
        {
          id: 'reasoning_effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    });

    const result = await cell.setConfigOption('effort', 'high');

    expect(isOk(result)).toBe(true);
    expect(agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'reasoning_effort',
      value: 'high',
    });
    expect(cell.config.efforts?.selected).toBe('high');
    expect(cell.rawLog.snapshot().events.map(({ event }) => event.kind)).toEqual([
      'session_config_option_request',
      'session_config_option_response',
    ]);
  });
});

/** 自报状态的家(claude 桥接 1.3.0 起):在不在干活只听它的 `state_update`。 */
function reportingCell() {
  const made = makeCell();
  made.cell.setReportsState(true);
  return made;
}

describe('SessionCell idle turns and queue commands', () => {
  /**
   * #6191 —— 没声明自发轮的家(copilot 那种:usage 从不带 cost),取消之后补来的一句
   * 「Info: Operation cancelled by user」曾开出一个**永远关不上**的自发轮:停止键常亮、
   * 追问全排队。它是被取消那一轮的尾巴:折进那一轮,❌ 不让会话重新变忙。
   */
  it('取消之后迟到的 agent 文本折进被取消那一轮,会话不再变忙,追问立刻发出', async () => {
    const { cell, agent } = makeCell();
    let resolvePrompt!: (value: { stopReason: string }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePrompt = resolve; }))
      .mockResolvedValue({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'sleep 120', origin: 'typed' });
    await Promise.resolve();
    await cell.cancel();
    resolvePrompt({ stopReason: 'cancelled' });
    await first;
    expect(cell.history().committed.at(-1)?.outcome?.kind).toBe('cancelled');

    cell.push({ kind: 'message', role: 'assistant', messageId: null, text: 'Info: Operation ' });
    cell.push({ kind: 'message', role: 'assistant', messageId: null, text: 'cancelled by user' });

    expect(cell.sessionState.lifecycle, '尾巴不让会话变忙').toBe('ready');
    expect(cell.sessionState.canCancel, '停止键不许重新亮').toBe(false);
    expect(cell.history().active).toBeNull();
    const stopped = cell.history().committed;
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.outcome?.kind, '结局不变').toBe('cancelled');
    const texts = stopped[0]!.items
      .filter((item) => item.kind === 'message' && (item as { role: string }).role === 'assistant')
      .map((item) => (item as { text: string }).text);
    expect(texts, '两段尾巴续在同一条消息上').toEqual(['Info: Operation cancelled by user']);

    const followUp = await cell.prompt({ text: 'K4', origin: 'typed' });
    expect(isOk(followUp)).toBe(true);
    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect(cell.sessionState.queuedPrompts, '追问不排队').toEqual([]);
  });

  it('尾巴的合成消息 id 不撞上那一轮已有的消息', async () => {
    const { cell, agent } = makeCell();
    let resolvePrompt!: (value: { stopReason: string }) => void;
    agent.prompt = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolvePrompt = resolve; }));
    const first = cell.prompt({ text: 'hi', origin: 'typed' });
    await Promise.resolve();
    cell.push({ kind: 'message', role: 'assistant', messageId: null, text: '正文' });
    resolvePrompt({ stopReason: 'end_turn' });
    await first;

    cell.push({ kind: 'message', role: 'assistant', messageId: null, text: '迟到' });

    const texts = cell.history().committed[0]!.items
      .filter((item) => item.kind === 'message' && (item as { role: string }).role === 'assistant')
      .map((item) => (item as { text: string }).text);
    expect(texts).toEqual(['正文', '迟到']);
    expect(cell.history().committed[0]!.outcome?.kind).toBe('done');
  });

  it('自报状态的家:agent 自己开工就忙,只有它报 idle 才停 —— 谁开的工都一样(#7087)', () => {
    const { cell } = reportingCell();
    cell.push({ kind: 'agent_state', state: 'running' });
    expect(cell.sessionState.lifecycle).toBe('working');
    cell.push({ kind: 'message', role: 'assistant', messageId: 'resp_1', text: '子任务跑完了' });
    expect(cell.history().active?.initiator).toBe('agent');
    // 带 cost 的 usage 不是「停了」:只有 idle 是。
    cell.push({
      kind: 'usage',
      usage: { contextUsed: 1, contextSize: 200_000, cost: { amount: 0.01, currency: 'USD' } },
    });
    expect(cell.sessionState.lifecycle).toBe('working');
    cell.push({ kind: 'agent_state', state: 'idle' });
    expect(cell.sessionState.lifecycle).toBe('ready');
    expect(cell.history().active).toBeNull();
    expect(cell.history().committed.at(-1)?.outcome).toEqual({ kind: 'done', reason: 'cycle_end' });
  });

  it('❌ 阴控:不自报状态的家收到 state_update 不动(它没声明,这条不是它的事实)', () => {
    const { cell } = makeCell();
    cell.push({ kind: 'agent_state', state: 'running' });
    expect(cell.sessionState.lifecycle).toBe('ready');
  });

  /**
   * #4981 —— agent 自己干的活,边界是它报的 idle,❌ 不是「静默了多久」。
   *
   * 这里曾经是 250 ms 定时器:网关流式中途停顿一下,正在写的那条消息就被当场封口,
   * 下一段字再懒开新的一组 —— owner 2026-09-06 真机上句号、右括号被切到下一段、半截消息底下
   * 冒出「复制消息」、在活动层/已提交层之间来回跳,全是它。
   *
   * 判据断言**后果**:停顿多久都不许切;idle 一到立刻收。装回定时器,第一条必红。
   */
  it('agent 自己干的活:流式中途停多久都不切、不切消息', async () => {
    vi.useFakeTimers();
    try {
      const { cell } = reportingCell();

      cell.push({ kind: 'agent_state', state: 'running' });
      cell.push({ kind: 'message', role: 'assistant', messageId: 'resp_1', text: '此前提供的三段正文可直接使用' });
      expect(cell.history().active?.initiator).toBe('agent');

      // 网关卡了 5 秒才把最后一个字送到 —— 真机上被切走的正是这个句号。
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      cell.push({ kind: 'message', role: 'assistant', messageId: 'resp_1', text: '。' });

      expect(cell.sessionState.lifecycle, '停顿不是边界,还在干活').toBe('working');
      expect(cell.history().committed.length, '停顿不许提交出一组').toBe(0);
      const texts = (cell.history().active?.items ?? [])
        .filter((item) => item.kind === 'message')
        .map((item) => (item as { text: string }).text);
      expect(texts).toEqual(['此前提供的三段正文可直接使用。']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('自报状态的家:请求先答复、idle 随后到 —— 在 idle 落定,用请求带来的结局', async () => {
    const { cell, agent } = reportingCell();
    let resolvePrompt!: (value: { stopReason: string }) => void;
    agent.prompt = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolvePrompt = resolve; }));
    const sent = cell.prompt({ text: 'hi', origin: 'typed' });
    await Promise.resolve();
    expect(cell.sessionState.lifecycle, '发出去不等于开工:等它报 running').toBe('ready');
    cell.push({ kind: 'agent_state', state: 'running' });
    expect(cell.sessionState.lifecycle).toBe('working');
    cell.push({ kind: 'message', role: 'assistant', messageId: 'r1', text: '好' });
    resolvePrompt({ stopReason: 'max_tokens' });
    await sent;
    expect(cell.sessionState.lifecycle, '请求答复了,agent 还没报 idle').toBe('working');
    expect(cell.history().committed).toHaveLength(0);
    cell.push({ kind: 'agent_state', state: 'idle' });
    expect(cell.sessionState.lifecycle).toBe('ready');
    expect(cell.history().committed.at(-1)?.outcome).toEqual({ kind: 'done', reason: 'max_tokens' });
  });

  it('自报状态的家:这一句根本没开工(本地命令,没报 running)—— 请求答复就落定,不卡在忙', async () => {
    const { cell } = reportingCell();
    await cell.prompt({ text: '/context', origin: 'typed' });
    expect(cell.sessionState.lifecycle).toBe('ready');
    expect(cell.history().active).toBeNull();
    expect(cell.history().committed.at(-1)?.outcome?.kind).toBe('done');
  });

  it('❌ 阴控:用户那一轮里的 result 走 prompt 结算,这条边界不插手', async () => {
    const { cell, agent } = makeCell();
    let resolvePrompt: (value: { stopReason: 'end_turn' }) => void = () => {};
    agent.prompt = vi.fn().mockReturnValue(
      new Promise<{ stopReason: 'end_turn' }>((resolve) => {
        resolvePrompt = resolve;
      })
    );
    const pending = cell.prompt({ text: '你好', origin: 'typed' });
    await Promise.resolve();
    cell.push({ kind: 'message', role: 'assistant', messageId: 'resp_1', text: '你好呀' });
    cell.push({
      kind: 'usage',
      usage: { contextUsed: 10, contextSize: 200_000, cost: { amount: 0.001, currency: 'USD' } },
    });
    expect(cell.history().active, '用户的轮要等 prompt 结算,usage 不许提前收').not.toBeNull();
    resolvePrompt({ stopReason: 'end_turn' });
    await pending;
    expect(cell.history().active).toBeNull();
  });

  it('holds a main-composer edit through real turn completion, then sends the saved text and attachments', async () => {
    const resolveAttachment = vi.fn().mockResolvedValue({ data: 'image-bytes', mimeType: 'image/png' });
    const { cell, agent } = makeCell(undefined, { resolveAttachment });
    let finish!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ stopReason: 'end_turn' });
    const active = cell.prompt({ text: 'working' });
    await Promise.resolve();
    const input = { text: 'original queued', origin: 'manual' as const, hiddenContext: 'keep context',
      attachments: [{ type: 'attachment' as const, id: 'a1', mimeType: 'image/png' as const }] };
    cell.queuePrompt(input);
    const original = cell.sessionState.queuedPrompts[0];
    expect(cell.editQueuedPrompt(original.id, input, { draftText: 'unfinished', originalDraftText: 'keep my draft' }).success).toBe(true);
    expect((await cell.steerQueuedPrompt(original.id)).success).toBe(false);
    finish({ stopReason: 'end_turn' }); await active; await flushDrains();
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(cell.sessionState.queuedPrompts[0]).toMatchObject({ id: original.id, text: 'original queued', hiddenContext: 'keep context', attachments: input.attachments });
    cell.setPromptDraft({ rev: 100, input: { text: 'keep my draft' } });
    expect(cell.promptDraft?.text).toBe('keep my draft');
    expect(cell.editQueuedPrompt(original.id, { ...input, text: 'saved edit' }, null).success).toBe(true);
    await flushDrains();
    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(agent.prompt.mock.calls[1])).toContain('saved edit');
    expect(JSON.stringify(agent.prompt.mock.calls[1])).toContain('image-bytes');
    expect(resolveAttachment).toHaveBeenCalledOnce();
    expect(cell.promptDraft?.text).toBe('keep my draft');
    expect(cell.sessionState.queuedPrompts).toEqual([]);
  });

  it('cancels a reserved queue edit during work without changing its original text or position', () => {
    const { cell } = makeCell();
    cell.machine.apply({ type: 'WorkStarted' });
    cell.queuePrompt({ text: 'original', origin: 'manual' });
    cell.queuePrompt({ text: 'second', origin: 'manual' });
    const original = cell.sessionState.queuedPrompts[0];
    cell.editQueuedPrompt(original.id, { text: original.text }, { draftText: 'discard me', originalDraftText: 'main draft' });
    cell.editQueuedPrompt(original.id, { text: original.text }, null);
    expect(cell.sessionState.queuedPrompts.map((p) => [p.id, p.text])).toEqual([[original.id, 'original'], [cell.sessionState.queuedPrompts[1].id, 'second']]);
    expect(cell.sessionState.queuedPrompts[0].queueEdit).toBeUndefined();
  });

  it('queues, edits, removes, and reorders queued prompts', () => {
    const { cell } = makeCell();

    expect(isOk(cell.queuePrompt({ text: 'a', origin: 'manual' }))).toBe(true);
    expect(isOk(cell.queuePrompt({ text: 'b', origin: 'manual' }))).toBe(true);
    const [first, second] = cell.sessionState.queuedPrompts;

    expect(isOk(cell.editQueuedPrompt(first.id, { text: 'edited' }))).toBe(true);
    expect(isOk(cell.reorderQueue([second.id, first.id]))).toBe(true);
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(cell.sessionState.queuedPrompts[1].text).toBe('edited');

    expect(isOk(cell.removeQueuedPrompt(first.id))).toBe(true);
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.id)).toEqual([second.id]);
  });

  /**
   * #6762 产品的排队入口与发送同一个准入。调用方读到的「在跑」可能已经过时(一轮刚讲完;聊天面还没挂上会话),
   * 照它原样入队 ⇒ 空闲会话上的队列再没有任何边界来抽干。阴控是上面那条:原样的 `queuePrompt` 照旧只排不发。
   */
  it('queueBehindTurn starts a turn on an idle session instead of parking the prompt (#6762)', async () => {
    const { cell, agent } = makeCell();

    const admitted = await cell.queueBehindTurn({ text: 'sent after the turn ended', origin: 'manual' });
    await flushDrains();

    expect(admitted).toEqual({ success: true, data: { queued: false } });
    expect(agent.prompt, 'the idle session takes the prompt at once').toHaveBeenCalledTimes(1);
    expect(cell.sessionState.queuedPrompts, 'nothing is left in an idle queue').toEqual([]);
  });

  // #6770:聊天面挂上之前(session/load 重放中)发的那一句,扣进队列、重放结束就发出去,❌ 卡在空闲会话的队列里。
  it('queueBehindTurn holds a prompt through a session/load replay, and the replay end sends it (#6770)', async () => {
    // 与 session/load 同序:cell 建出来还在 starting,重放从那里开始(makeCell 已经 applySessionReady,不适用)。
    const agent = new FakeAcpAgent();
    const cell = new SessionCell({
      mergeEnvelopes: stubMergeEnvelopes, sessionId: 'conv-1', projectId: 'proj-1', providerId: 'claude',
      acpSessionId: 'session-1', agent, liveSettings: TEST_LIVE_SETTINGS,
      resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }), logger: noopLogger,
    });
    cell.beginReplay();
    expect(cell.sessionState.lifecycle).toBe('replaying');

    const admitted = await cell.queueBehindTurn({ text: 'sent while replaying', origin: 'manual' });

    expect(admitted).toEqual({ success: true, data: { queued: true } });
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual(['sent while replaying']);
    expect(agent.prompt, 'nothing is sent into the replay').not.toHaveBeenCalled();

    cell.endReplay();
    await flushDrains();

    expect(agent.prompt, 'the replay end drained it').toHaveBeenCalledTimes(1);
    expect(cell.sessionState.queuedPrompts).toEqual([]);
  });

  it('queueBehindTurn queues behind a turn in flight, and that turn end drains it (#6762)', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: string }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ stopReason: 'end_turn' });
    const first = cell.prompt({ text: 'first', origin: 'typed' });

    const admitted = await cell.queueBehindTurn({ text: 'second', origin: 'manual' });

    expect(admitted).toEqual({ success: true, data: { queued: true } });
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual(['second']);
    expect(agent.prompt).toHaveBeenCalledTimes(1);

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();

    expect(agent.prompt, 'the queued prompt went out when the turn ended').toHaveBeenCalledTimes(2);
    expect(cell.sessionState.queuedPrompts).toEqual([]);
  });
});

/**
 * #5117 停一个后台子智能体:走 ACP 扩展方法 `_session/async_task/stop`,❌ 不动这一轮。
 * 判据分三支:送到并停了 / 送到但适配器说「没有这个活」/ 根本送不出去。
 */
describe('SessionCell stopBackgroundTask', () => {
  it('sends _session/async_task/stop with the session id and the task id, and reports ok', async () => {
    const { cell, agent } = makeCell();
    const result = await cell.stopBackgroundTask('toolu_launch');
    expect(result).toEqual({ success: true, data: undefined });
    expect(agent.extMethod).toHaveBeenCalledWith('_session/async_task/stop', {
      sessionId: 'session-1',
      asyncTaskId: 'toolu_launch',
    });
  });

  it('reports invalid_state when the adapter says the task is not live (stopped:false) — ❌ no fake success', async () => {
    const { cell, agent } = makeCell();
    agent.extMethod = vi.fn().mockResolvedValue({ stopped: false });
    const result = await cell.stopBackgroundTask('toolu_gone');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('invalid_state');
  });

  it('reports stop_task_failed when the request itself fails (e.g. method not found on a non-claude adapter)', async () => {
    const { cell, agent } = makeCell();
    agent.extMethod = vi.fn().mockRejectedValue(new Error('Method not found'));
    const result = await cell.stopBackgroundTask('toolu_launch');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('stop_task_failed');
      expect('cause' in result.error && result.error.cause?.message).toBe('Method not found');
    }
  });

  it('reports invalid_state when the connection has no extension methods at all', async () => {
    const agent = new FakeAcpAgent();
    (agent as { extMethod?: unknown }).extMethod = undefined;
    const { cell } = makeCell(agent);
    const result = await cell.stopBackgroundTask('toolu_launch');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('invalid_state');
  });
});

describe('#6387 extension messages: same-key replacement and attached context', () => {
  it('a newer queued prompt with the same key replaces the one still waiting, in place', async () => {
    const mergeEnvelopes = vi.fn(stubMergeEnvelopes);
    const { cell, agent } = makeCell(new FakeAcpAgent(), { mergeEnvelopes });
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; })
      )
      .mockResolvedValue({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'busy', origin: 'typed' });
    await cell.prompt({ text: '<gugu_delivery n="1"/>', origin: 'communication', coalesceKey: 'ext:sel' });
    await cell.prompt({ text: '<gugu_delivery n="note"/>', origin: 'communication' });
    const heldId = cell.sessionState.queuedPrompts[0]?.id;
    await cell.prompt({ text: '<gugu_delivery n="5"/>', origin: 'communication', coalesceKey: 'ext:sel' });

    // 五次点击 ⇒ 一条:还在排的那条换成新内容,位置与 id 不变。
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual([
      '<gugu_delivery n="5"/>',
      '<gugu_delivery n="note"/>',
    ]);
    expect(cell.sessionState.queuedPrompts[0]?.id).toBe(heldId);

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();
    expect(mergeEnvelopes.mock.calls[0][0]).toEqual(['<gugu_delivery n="5"/>', '<gugu_delivery n="note"/>']);
  });

  it('a prompt without a key never replaces anything', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn(() => new Promise<{ stopReason: 'end_turn' }>(() => {}));
    void cell.prompt({ text: 'busy', origin: 'typed' });
    await cell.prompt({ text: '<a/>', origin: 'communication' });
    await cell.prompt({ text: '<a/>', origin: 'communication' });
    expect(cell.sessionState.queuedPrompts).toHaveLength(2);
  });

  it('attached context wakes nobody, rides with the next turn, and shows in that turn', async () => {
    const mergeEnvelopes = vi.fn(stubMergeEnvelopes);
    const { cell, agent } = makeCell(new FakeAcpAgent(), { mergeEnvelopes });
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });

    cell.setTurnContext('ext:sel', '<ctx n="1"/>');
    cell.setTurnContext('ext:note', '<ctx n="note"/>');
    cell.setTurnContext('ext:sel', '<ctx n="3"/>');
    // 挂上去不起一轮。
    expect(agent.prompt).not.toHaveBeenCalled();

    await cell.prompt({ text: 'what am I looking at?', origin: 'manual' });
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    // 同键只留最新,且顺序跟着变新;合成走宿主注入的那一个属主。
    expect(mergeEnvelopes.mock.calls[0][0]).toEqual(['<ctx n="note"/>', '<ctx n="3"/>']);
    const request = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.prompt).toEqual([
      { type: 'text', text: '<gugu_deliveries count="2"><ctx n="note"/><ctx n="3"/></gugu_deliveries>' },
      { type: 'text', text: 'what am I looking at?' },
    ]);

    // 用户看得见 agent 收到了什么:同一轮里,人那一句后面跟着附带那一行。
    const turn = cell.transcript.history.at(-1) ?? cell.transcript.activeTurn;
    const userTexts = turn!.items
      .filter((item) => item.kind === 'message' && item.role === 'user')
      .map((item) => (item as { text: string }).text);
    expect(userTexts).toEqual([
      'what am I looking at?',
      '<gugu_deliveries count="2"><ctx n="note"/><ctx n="3"/></gugu_deliveries>',
    ]);

    // 发过即清:下一轮不再带。
    await cell.prompt({ text: 'next', origin: 'manual' });
    expect((agent.prompt as ReturnType<typeof vi.fn>).mock.calls[1][0].prompt).toEqual([
      { type: 'text', text: 'next' },
    ]);
  });

  it('attached context is not carried off by a message steered into the turn in flight', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; })
      )
      .mockResolvedValue({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'busy', origin: 'typed' });
    cell.setTurnContext('ext:sel', '<ctx/>');
    // 别的 agent 的一条消息插进了在飞的这一轮 —— 它 ❌ 带走扩展的附带。
    await cell.prompt({ text: '<other/>', origin: 'communication' }, { steerIfBusy: true });
    const calls = () => (agent.prompt as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].prompt);
    expect(calls()[1]).toEqual([{ type: 'text', text: '<other/>' }]);

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    // 附带随真正的下一轮进去。
    await cell.prompt({ text: 'next', origin: 'manual' });
    expect(calls()[2]).toEqual([{ type: 'text', text: '<ctx/>' }, { type: 'text', text: 'next' }]);
  });

  it('admission says when a prompt went into the turn in flight rather than starting one', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn(() => new Promise<{ stopReason: 'end_turn' }>(() => {}));
    void cell.prompt({ text: 'busy', origin: 'typed' });
    const steered = cell.promptDetached({ text: 'mid', origin: 'communication' }, { steerIfBusy: true });
    await expect(steered.admission).resolves.toEqual({ success: true, data: { queued: false, steered: true } });
    const queued = cell.promptDetached({ text: 'later', origin: 'communication' });
    await expect(queued.admission).resolves.toEqual({ success: true, data: { queued: true } });
  });
});

// #6574 排队提示的「立即发送」在能插话的家上:插进在飞的那一轮,❌ 取消它。
describe('SessionCell.steerQueuedPrompt', () => {
  const queuedIds = (cell: SessionCell) => cell.sessionState.queuedPrompts.map((prompt) => prompt.id);
  const queuedTexts = (cell: SessionCell) => cell.sessionState.queuedPrompts.map((prompt) => prompt.text);
  const activeMessages = (cell: SessionCell) =>
    (cell.history().active?.items ?? [])
      .filter((item) => item.kind === 'message')
      .map((item) => item as { id: string; text: string });

  function busyCellWithQueue(extra: Record<string, unknown> = {}) {
    const agent = new FakeAcpAgent();
    const { cell } = makeCell(agent, extra);
    let resolveFirst!: (value: { stopReason: string }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ stopReason: 'end_turn' });
    agent.cancel = vi.fn(async () => ({}));
    const first = cell.prompt({ text: 'first' });
    expect(isOk(cell.queuePrompt({ text: 'a', origin: 'manual' }))).toBe(true);
    expect(isOk(cell.queuePrompt({ text: 'b', origin: 'manual' }))).toBe(true);
    const [, b] = queuedIds(cell);
    return { cell, agent, first, b: b!, resolveFirst: (stopReason: string) => resolveFirst({ stopReason }) };
  }

  it('native steering: the chosen entry leaves the queue into the running turn; nothing is cancelled, the draft stays', async () => {
    const { cell, agent, first, b, resolveFirst } = busyCellWithQueue({ supportsSteering: true });
    agent.extMethod = vi.fn().mockResolvedValue({ outcome: 'injected' });
    // 排队那两下各清过一次草稿(版本号随之上涨),所以这里要用更新的版本号;先证明它确实存进去了。
    expect(isOk(cell.setPromptDraft({ rev: 100, input: { text: 'typing the next one' } }))).toBe(true);
    expect(cell.promptDraft?.text).toBe('typing the next one');

    await expect(cell.steerQueuedPrompt(b)).resolves.toEqual({ success: true, data: undefined });

    expect(agent.extMethod).toHaveBeenCalledWith('_session/steering', expect.objectContaining({
      prompt: [{ type: 'text', text: 'b' }],
    }));
    expect(agent.cancel).not.toHaveBeenCalled();
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(queuedTexts(cell)).toEqual(['a']);
    expect(cell.sessionState.lifecycle).toBe('working');
    // 转录里是同一条:沿用排队条目的稳定 id,落在这一轮里。
    expect(activeMessages(cell).map((item) => item.text)).toEqual(['first', 'b']);
    expect(activeMessages(cell)[1]!.id).toContain(b);
    // composer 里正在打的那句 ❌ 被当成「已发出」清掉。
    expect(cell.promptDraft?.text).toBe('typing the next one');

    resolveFirst('end_turn');
    await first;
    await flushDrains();
    // 剩下的那条照常在回合末出队。
    expect(JSON.stringify((agent.prompt as ReturnType<typeof vi.fn>).mock.calls[1]![0])).toContain('"a"');
  });

  it('native steering refused (#7087): no row is drawn, the entry stays at the front of the queue', async () => {
    const { cell, agent, first, b, resolveFirst } = busyCellWithQueue({ supportsSteering: true });
    agent.extMethod = vi.fn().mockResolvedValue({ outcome: 'promptRequired', reason: 'noRunningTurn' });

    await expect(cell.steerQueuedPrompt(b)).resolves.toEqual({ success: true, data: undefined });

    // 没进去的那句 ❌ 画成已发出;它仍排在队首,等这一轮讲完第一个出队。
    expect(activeMessages(cell).map((item) => item.text)).toEqual(['first']);
    expect(queuedTexts(cell)).toEqual(['b', 'a']);
    expect(agent.prompt).toHaveBeenCalledTimes(1);

    resolveFirst('end_turn');
    await first;
    await flushDrains();
    expect((agent.prompt as ReturnType<typeof vi.fn>).mock.calls[1]![0].prompt).toEqual([{ type: 'text', text: 'b' }]);
    const userRows = cell.history().committed.concat(cell.history().active ? [cell.history().active!] : [])
      .flatMap((turn) => turn.items)
      .filter((item) => item.kind === 'message' && (item as { text: string }).text === 'b');
    expect(userRows).toHaveLength(1);
  });

  it('native steering request fails: the failure goes back to the caller and the row stays drawn (#4660)', async () => {
    const { cell, agent, first, b, resolveFirst } = busyCellWithQueue({ supportsSteering: true });
    agent.extMethod = vi.fn().mockRejectedValue(new Error('steering transport closed'));

    const result = await cell.steerQueuedPrompt(b);

    expect(result.success).toBe(false);
    expect(activeMessages(cell).map((item) => item.text)).toEqual(['first', 'b']);
    expect(queuedTexts(cell)).toEqual(['a']);
    resolveFirst('end_turn');
    await first;
  });

  it('concurrent session/prompt lane: sends the entry as a second prompt right away, without cancelling', async () => {
    const { cell, agent, first, b, resolveFirst } = busyCellWithQueue();
    const steered = cell.steerQueuedPrompt(b);
    await flushDrains();

    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect((agent.prompt as ReturnType<typeof vi.fn>).mock.calls[1]![0].prompt).toEqual([{ type: 'text', text: 'b' }]);
    expect(agent.cancel).not.toHaveBeenCalled();
    expect(queuedTexts(cell)).toEqual(['a']);
    await expect(steered).resolves.toEqual({ success: true, data: undefined });

    resolveFirst('end_turn');
    await first;
  });

  it('no turn to join (being cancelled): moves the entry to the front so the next drain takes it', async () => {
    const { cell, agent, first, b, resolveFirst } = busyCellWithQueue();
    await cell.cancel();
    expect(cell.sessionState.lifecycle).toBe('cancelling');

    await expect(cell.steerQueuedPrompt(b)).resolves.toEqual({ success: true, data: undefined });
    expect(queuedTexts(cell)).toEqual(['b', 'a']);
    expect(agent.prompt).toHaveBeenCalledTimes(1);

    resolveFirst('cancelled');
    await first;
    await flushDrains();
    expect((agent.prompt as ReturnType<typeof vi.fn>).mock.calls[1]![0].prompt).toEqual([{ type: 'text', text: 'b' }]);
  });

  it('an id that is no longer queued is a no-op', async () => {
    const { cell, agent, first, resolveFirst } = busyCellWithQueue();
    await expect(cell.steerQueuedPrompt('gone')).resolves.toEqual({ success: true, data: undefined });
    expect(queuedTexts(cell)).toEqual(['a', 'b']);
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    resolveFirst('end_turn');
    await first;
  });
});

// 复核 66(#3684 测量里撞见):人话和投递同时在等时按到达顺序。投递只在没人排队时插进当前这一轮;
// 「立即发送」照插(由上面 steerQueuedPrompt 的几格钉住:队列里另有一条 'a' 时,点的那条仍插进在飞那一轮)。
describe('SessionCell arrival order between typed prompts and deliveries', () => {
  const sentTexts = (agent: FakeAcpAgent) =>
    (agent.prompt as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].prompt.map((block: { text?: string }) => block.text).join(''));

  it.each([
    ['concurrent session/prompt lane', {}],
    ['native steering lane', { supportsSteering: true }],
  ])('%s: a delivery arriving after a queued typed prompt queues behind it, and the typed prompt dequeues first', async (_lane, extra) => {
    const agent = new FakeAcpAgent();
    agent.extMethod = vi.fn().mockResolvedValue({ outcome: 'injected' });
    const { cell } = makeCell(agent, extra);
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(() => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'busy', origin: 'typed' });
    await expect(cell.queueBehindTurn({ text: 'typed while busy', origin: 'typed' })).resolves.toEqual({ success: true, data: { queued: true } });
    const delivery = cell.promptDetached({ text: '<dm/>', origin: 'communication' }, { steerIfBusy: true });
    await expect(delivery.admission).resolves.toEqual({ success: true, data: { queued: true } });
    // ❌ 插进在飞的那一轮:没有第二次 session/prompt,也没有 _session/steering。
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(agent.extMethod).not.toHaveBeenCalled();
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual(['typed while busy', '<dm/>']);

    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();
    expect(sentTexts(agent)).toEqual(['busy', 'typed while busy', '<dm/>']);
    expect(cell.sessionState.queuedPrompts).toEqual([]);
  });

  it('with nobody queued, a busy-time delivery still steers into the turn in flight', async () => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(() => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ stopReason: 'end_turn' });

    const first = cell.prompt({ text: 'busy', origin: 'typed' });
    const delivery = cell.promptDetached({ text: '<dm/>', origin: 'communication' }, { steerIfBusy: true });
    await expect(delivery.admission).resolves.toEqual({ success: true, data: { queued: false, steered: true } });
    await flushDrains();
    expect(sentTexts(agent)).toEqual(['busy', '<dm/>']);

    resolveFirst({ stopReason: 'end_turn' });
    await first;
  });

  // 设置生效的闸:空闲会话上一个设置还在确认时,人话被扣在队列里;后到的投递同样扣在它后面(❌ 绕过闸先开一轮)。
  it('while a live setting is being confirmed, a delivery arriving after a held typed prompt is held behind it', async () => {
    const { cell, agent } = makeCell();
    const modelOptions = (currentValue: string) => [{
      id: 'model',
      name: 'Model',
      category: 'model' as const,
      type: 'select' as const,
      currentValue,
      options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }],
    }];
    cell.applySessionMeta({ configOptions: modelOptions('model-a') });
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    let confirm!: (value: { configOptions: ReturnType<typeof modelOptions> }) => void;
    agent.setSessionConfigOption = vi.fn(() => new Promise((resolve) => { confirm = resolve; }));

    const mutation = cell.setConfigOption('model', 'model-b');
    await expect(cell.queueBehindTurn({ text: 'typed while confirming', origin: 'typed' })).resolves.toEqual({ success: true, data: { queued: true } });
    const delivery = cell.promptDetached({ text: '<dm/>', origin: 'communication' }, { steerIfBusy: true });
    await expect(delivery.admission).resolves.toEqual({ success: true, data: { queued: true } });
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual(['typed while confirming', '<dm/>']);

    await flushDrains();
    confirm({ configOptions: modelOptions('model-b') });
    await mutation;
    await flushDrains();
    expect(sentTexts(agent)).toEqual(['typed while confirming', '<dm/>']);
    expect(cell.sessionState.queuedPrompts).toEqual([]);
  });

  // 排队的那一轮失败 ⇒ 队列停在空闲上(#4493:不自动重发)。新来的一句照样开一轮,讲完把队列抽干 ——
  // ❌ 因为「队列非空」就把它也排进去:那样再没有边界来抽干,会话卡死(只有 agent 的会话没人来救)。
  it.each([
    ['typed prompt from the composer', (cell: SessionCell) => cell.queueBehindTurn({ text: 'new words', origin: 'typed' })],
    ['delivery', (cell: SessionCell) => cell.promptDetached({ text: 'new words', origin: 'communication' }, { steerIfBusy: true }).admission],
  ])('after a failed queued turn leaves a paused queue, a new %s still starts a turn and the queue drains after it', async (_who, send) => {
    const { cell, agent } = makeCell();
    let resolveFirst!: (value: { stopReason: 'end_turn' }) => void;
    let rejectBatch!: (reason: Error) => void;
    agent.prompt = vi
      .fn()
      .mockImplementationOnce(() => new Promise<{ stopReason: 'end_turn' }>((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise<{ stopReason: 'end_turn' }>((_r, rej) => { rejectBatch = rej; }))
      .mockResolvedValue({ stopReason: 'end_turn' });
    const first = cell.prompt({ text: 'first', origin: 'typed' });
    await cell.prompt({ text: 'batch', origin: 'typed' });
    resolveFirst({ stopReason: 'end_turn' });
    await first;
    await flushDrains();
    await cell.prompt({ text: 'during', origin: 'typed' });
    rejectBatch(new Error('provider rate limited'));
    await flushDrains();
    expect(cell.sessionState.lifecycle).toBe('ready');
    expect(cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual(['during']);

    await expect(send(cell)).resolves.toEqual({ success: true, data: { queued: false } });
    await flushDrains();
    expect(sentTexts(agent)).toEqual(['first', 'batch', 'new words', 'during']);
    expect(cell.sessionState.queuedPrompts).toEqual([]);
    expect(cell.sessionState.lifecycle).toBe('ready');
  });
});


describe('native in-place conversation revert', () => {
  it('keeps the native ID, removes the suffix, and holds admission until display history is committed', async () => {
    const { cell, agent } = makeCell();
    let n = 0;
    agent.prompt = vi.fn().mockImplementation(async () => ({ stopReason: 'end_turn', _meta: { guguRevert: { before: `native-${++n}` } } }));
    for (const text of ['keep', 'discard', 'discard later']) await cell.prompt({ text });
    expect(cell.history().committed.flatMap((turn) => turn.items).filter((item) => item.kind === 'message')
      .map((item) => item.kind === 'message' && item.revertAnchor)).toEqual(['native-1', 'native-2', 'native-3']);
    agent.extMethod = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
    expect(await cell.revertSession('native-2')).toEqual({ success: true, data: { providerSessionId: 'session-1' } });
    expect(agent.extMethod).toHaveBeenCalledWith('_session/revert', { sessionId: 'session-1', before: 'native-2' });
    expect(cell.history().committed).toHaveLength(1);
    expect(cell.history().committed[0].items[0]).toMatchObject({ text: 'keep' });
    expect(await cell.prompt({ text: 'cannot race persistence' })).toMatchObject({ success: false, error: { type: 'session_busy' } });
    cell.finishHistoryRevert();
    expect(await cell.prompt({ text: 'replacement' })).toMatchObject({ success: true });
    expect(cell.acpSessionId).toBe('session-1');
    expect(cell.history().committed).toHaveLength(2);
  });

  it('leaves the transcript unchanged on native refusal or identity change', async () => {
    const { cell, agent } = makeCell();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    await cell.prompt({ text: 'retained on failure' });
    const before = cell.transcript.history;
    agent.extMethod = vi.fn().mockRejectedValue(new Error('legacy history is unsupported'));
    expect(await cell.revertSession('native')).toMatchObject({ success: false });
    expect(cell.transcript.history).toBe(before);
    agent.extMethod = vi.fn().mockResolvedValue({ sessionId: 'a-new-thread' });
    expect(await cell.revertSession('native')).toMatchObject({ success: false });
    expect(cell.transcript.history).toBe(before);
  });

  it('refuses concurrent work before issuing a native mutation', async () => {
    const { cell, agent } = makeCell();
    let finish!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const running = cell.prompt({ text: 'in flight' });
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalled());
    agent.extMethod = vi.fn();
    expect(await cell.revertSession('native')).toMatchObject({ success: false, error: { type: 'session_busy' } });
    expect(agent.extMethod).not.toHaveBeenCalled();
    finish({ stopReason: 'end_turn' }); await running;
  });
});

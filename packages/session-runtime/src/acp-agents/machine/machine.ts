import type {
  AcpPermissionRequest,
  AcpRuntimeError,
  AdapterExit,
  PromptInput,
  QueuedPrompt,
  QueuedPromptEdit,
  SessionLifecycle,
  SessionFailure,
  SessionState,
  LastTurnOutcome,
  StopReason,
} from '@gugu/session-core/acp';
import { acpErr } from '@gugu/session-core/acp';
import type { Result } from '@gugu/session-shared';
import { ok } from '@gugu/session-shared';

/**
 * 会话的状态。`working` = agent 在干活,谁开的工都一样;它从哪来由 cell 在边界上定(agent 自报的
 * `state_update`,不报的家用「prompt 请求还没答」)。❌ 这里没有「轮」:决定排队、插话、取消、
 * 抽干的只有这个状态(owner 10-10,#7087)。
 */
export type SessionPhase =
  | { kind: 'starting' }
  | { kind: 'replaying' }
  | { kind: 'ready' }
  | { kind: 'working' }
  | { kind: 'cancelling' }
  | { kind: 'lost'; failure: SessionFailure }
  | { kind: 'closed'; exitCode: number | null };

export interface SessionMachineContext {
  modeIds?: readonly string[];
  configOptionIds?: readonly string[];
}

export function emptySessionMachineContext(): SessionMachineContext {
  return { modeIds: [], configOptionIds: [] };
}

export function phaseToLifecycle(phase: SessionPhase): SessionLifecycle {
  return phase.kind;
}

/**
 * 「引擎怎么没的」这句话的**唯一**写入者。
 *
 * ⚠️ 被 SIGKILL 的进程 `exitCode` 是 null、`signal` 才是 `SIGKILL` ⇒ 只看退出码时,
 * 这句话会退化成一句没有任何信息的「ACP adapter exited unexpectedly」。信号在连接层
 * 一直都有,只是没走到这里(#5858)。
 */
function adapterExitFailure(exit: AdapterExit): SessionFailure {
  const how = exit.exitCode !== null
    ? ` (code ${exit.exitCode})`
    : exit.signal
      ? ` (signal ${exit.signal})`
      : '';
  return {
    kind: 'adapter-exit',
    exitCode: exit.exitCode,
    signal: exit.signal,
    message: `ACP adapter exited unexpectedly${how}`,
  };
}

export interface SessionMachineState {
  readonly sessionId: string;
  readonly phase: SessionPhase;
  readonly failure: SessionFailure | null;
  readonly pendingPermissions: readonly AcpPermissionRequest[];
  readonly lastStopReason: StopReason | null;
  readonly lastTurnOutcome: LastTurnOutcome;
  readonly queuedPrompts: readonly QueuedPrompt[];
  readonly backgroundAgentCount: number;
  /**
   * 还在跑的后台命令的任务 id(`runningBackgroundCommands` 的结果):只给状态读,不让会话变忙、也不开取消
   * (命令在自己的卡上停)。`backgroundCommandCount` 是它的长度,在投影里算 —— ❌ 另存一个数。
   */
  readonly backgroundCommandTaskIds: readonly string[];
}

export function initialMachineState(sessionId: string): SessionMachineState {
  return {
    sessionId,
    phase: { kind: 'starting' },
    failure: null,
    pendingPermissions: [],
    lastStopReason: null,
    lastTurnOutcome: 'none',
    queuedPrompts: [],
    backgroundAgentCount: 0,
    backgroundCommandTaskIds: [],
  };
}

export type Command =
  | {
      type: 'Prompt';
      prompt: QueuedPrompt;
      steerIfBusy?: boolean;
    }
  | { type: 'QueuePrompt'; prompt: QueuedPrompt }
  | { type: 'Cancel' }
  | { type: 'EditQueuedPrompt'; id: string; input: PromptInput; updatedAt: number; queueEdit?: QueuedPromptEdit | null }
  | { type: 'RemoveQueuedPrompt'; id: string }
  | { type: 'ReorderQueue'; ids: readonly string[] }
  | { type: 'ResolvePermission'; requestId: string; optionId: string }
  | { type: 'SetMode'; modeId: string }
  | { type: 'SetConfigOption'; configId: string; value: string };

export type DomainEvent =
  | { type: 'ReplayStarted' }
  | { type: 'ReplayEnded'; status: 'complete' | 'error' | 'cancelled' }
  /** #7223 重放没发生(引擎没有这条,这一次改走 session/new):回到 starting,排着的话留给 SessionReady 抽干。 */
  | { type: 'ReplayAbandoned' }
  | { type: 'SessionReady' }
  | { type: 'SessionLoaded' }
  | { type: 'PromptStarted'; prompt: QueuedPrompt }
  | { type: 'PromptSteered'; prompt: QueuedPrompt }
  | { type: 'PromptQueued'; prompt: QueuedPrompt }
  | { type: 'QueuedPromptEdited'; id: string; input: PromptInput; updatedAt: number; queueEdit?: QueuedPromptEdit | null }
  | { type: 'QueuedPromptRemoved'; id: string }
  | { type: 'QueueReordered'; ids: readonly string[] }
  /** agent 开始干活(ready → working)。 */
  | { type: 'WorkStarted' }
  /** agent 停下了(working/cancelling → ready):记下怎么停的,抽干队列。 */
  | { type: 'WorkEnded'; outcome: TurnOutcome; dequeueQueuedPrompt?: boolean }
  | { type: 'AgentsChanged'; runningCount: number }
  | { type: 'BackgroundCommandsChanged'; taskIds: readonly string[] }
  | { type: 'CancellationRequested' }
  | { type: 'PermissionRequested'; request: AcpPermissionRequest }
  | { type: 'PermissionResolved'; requestId: string }
  /** A live setting was confirmed; release prompts held at the next-turn barrier. */
  | { type: 'SettingsReady' }
  | { type: 'ProcessClosed'; exit: AdapterExit; abnormal?: boolean };

export type TurnOutcome = { kind: 'stopped'; stopReason: StopReason } | { kind: 'errored' };

export type Effect =
  | { type: 'state' }
  | { type: 'permissionRequest'; request: AcpPermissionRequest }
  | { type: 'permissionResolved'; requestId: string; cancelled: boolean }
  | { type: 'closed'; exitCode: number | null }
  | { type: 'agentEvent'; phase: 'start' | 'stop' | 'error' }
  | { type: 'settleAgents'; scope: 'turn' | 'all'; status: 'completed' | 'failed' }
  | { type: 'sendPrompt'; sources: readonly QueuedPrompt[] }
  | { type: 'promptSteered'; prompt: QueuedPrompt }
  /** 这一句现在就发(会话空闲)。开不开工由 agent 的状态说,不由这里说。 */
  | { type: 'promptStarted'; prompt: QueuedPrompt }
  | { type: 'warn'; message: string };

export function decide(
  s: SessionMachineState,
  cmd: Command,
  ctx: SessionMachineContext = emptySessionMachineContext()
): Result<DomainEvent[], AcpRuntimeError> {
  switch (cmd.type) {
    case 'Prompt':
      // 「忙」只看 agent 在不在干活;只剩后台是 park,新来的一句直接发,不排到后台跑完。
      if (isBusy(s)) {
        // spec session-injection(next-tool-call 档的 mid-turn 支):忙时把同一条标准 session/prompt
        // **立即**发进当前 turn,❌ 不落 PromptQueued(那正是曾把 opencode 挡成 idle-only 的那道闸)。
        // 单线程 decide 里判定 = 原子;只有会话上那家 harness 声明了 next-tool-call 的调用方才会带这个旗。
        // ⚠️ 正在取消时没有活可折进去(#4708 review):这时 steer 只会把字节交给一条
        // 正被打断的 RPC;改落队列,取消完成的 WorkEnded 会一次抽干 —— 模型仍然看得见,只是等取消落定。
        if (cmd.steerIfBusy && s.phase.kind !== 'cancelling') {
          return ok([{ type: 'PromptSteered', prompt: cmd.prompt }]);
        }
        return ok([{ type: 'PromptQueued', prompt: cmd.prompt }]);
      }
      if (s.phase.kind === 'starting') {
        // A session cell exists before provider session/new completes. Hold manual prompts in the
        // same runtime queue as every other queued prompt; SessionReady owns the first drain.
        return ok([{ type: 'PromptQueued', prompt: cmd.prompt }]);
      }
      if (!isPromptReady(phaseToLifecycle(s.phase))) {
        return acpErr.invalidState(`Cannot send a prompt while session is '${s.phase.kind}'`);
      }
      return ok([{ type: 'PromptStarted', prompt: cmd.prompt }]);

    case 'QueuePrompt':
      return ok([{ type: 'PromptQueued', prompt: cmd.prompt }]);

    case 'Cancel':
      if (s.phase.kind !== 'working' && s.backgroundAgentCount === 0) {
        return ok([]);
      }
      return ok([{ type: 'CancellationRequested' }]);

    case 'EditQueuedPrompt': {
      const prompt = s.queuedPrompts.find((entry) => entry.id === cmd.id);
      if (cmd.queueEdit && (s.phase.kind === 'closed' || s.phase.kind === 'lost' || s.phase.kind === 'replaying')) {
        return acpErr.invalidState('The session cannot reserve a queued message for editing');
      }
      if (cmd.queueEdit && s.queuedPrompts.some((entry) => entry.id !== cmd.id && entry.queueEdit)) {
        return acpErr.invalidState('Another queued message is already being edited');
      }
      if (!prompt) return cmd.queueEdit === undefined ? ok([])
        : acpErr.invalidState('The queued message is no longer available for editing');
      // Acquiring/updating an edit never replaces the committed prompt with a stale client echo.
      const input = cmd.queueEdit ? { text: prompt.text, origin: prompt.origin,
        hiddenContext: prompt.hiddenContext, attachments: prompt.attachments, coalesceKey: prompt.coalesceKey } : cmd.input;
      const queueEdit = cmd.queueEdit && !prompt.queueEdit ? { ...cmd.queueEdit, draftText: prompt.text } : cmd.queueEdit;
      return ok([{ type: 'QueuedPromptEdited', id: cmd.id, input, updatedAt: cmd.updatedAt,
        ...(queueEdit !== undefined ? { queueEdit } : {}) }]);
    }

    case 'RemoveQueuedPrompt':
      if (!s.queuedPrompts.some((prompt) => prompt.id === cmd.id)) return ok([]);
      return ok([{ type: 'QueuedPromptRemoved', id: cmd.id }]);

    case 'ReorderQueue': {
      const knownIds = new Set(s.queuedPrompts.map((prompt) => prompt.id));
      if (cmd.ids.length !== knownIds.size || cmd.ids.some((id) => !knownIds.has(id))) {
        return acpErr.invalidState('Queue reorder ids must match the queued prompts');
      }
      return ok([{ type: 'QueueReordered', ids: cmd.ids }]);
    }

    case 'ResolvePermission':
      if (!s.pendingPermissions.some((p) => p.requestId === cmd.requestId)) {
        return acpErr.invalidState(`No pending permission request with id '${cmd.requestId}'`);
      }
      return ok([{ type: 'PermissionResolved', requestId: cmd.requestId }]);

    case 'SetMode':
      if (!ctx.modeIds?.includes(cmd.modeId)) {
        return acpErr.setModeFailed({
          name: 'Error',
          message: `Mode '${cmd.modeId}' is not in the available modes list`,
        });
      }
      return ok([]);

    case 'SetConfigOption':
      if (!ctx.configOptionIds?.includes(cmd.configId)) {
        return acpErr.setConfigFailed({
          name: 'Error',
          message: `Config option '${cmd.configId}' is not known`,
        });
      }
      return ok([]);
  }
}

export function evolve(
  s: SessionMachineState,
  ev: DomainEvent
): { state: SessionMachineState; effects: Effect[] } {
  switch (ev.type) {
    case 'ReplayStarted': {
      if (s.phase.kind !== 'starting') return warn(s, `ReplayStarted in phase '${s.phase.kind}'`);
      return {
        state: { ...s, phase: { kind: 'replaying' } },
        effects: [{ type: 'state' }],
      };
    }

    case 'ReplayEnded': {
      if (s.phase.kind !== 'replaying') return warn(s, `ReplayEnded in phase '${s.phase.kind}'`);
      const { queuedPrompts, effects: queueEffects } = dequeuePromptEffects(s.queuedPrompts);
      return {
        state: {
          ...s,
          phase: { kind: 'ready' },
          queuedPrompts,
          ...(ev.status === 'error' ? { lastTurnOutcome: 'errored' as const } : {}),
        },
        effects: [
          { type: 'state' },
          ...(ev.status === 'error'
            ? [{ type: 'agentEvent' as const, phase: 'error' as const }]
            : []),
          { type: 'settleAgents', scope: 'turn', status: 'completed' },
          ...queueEffects,
        ],
      };
    }

    case 'ReplayAbandoned': {
      if (s.phase.kind !== 'replaying') return warn(s, `ReplayAbandoned in phase '${s.phase.kind}'`);
      // ❌ 像 ReplayEnded 那样进 ready 并当场抽干:这时会话还没有新 id,抽出去的话会发往那个不存在的旧会话。
      return {
        state: { ...s, phase: { kind: 'starting' } },
        effects: [{ type: 'state' }],
      };
    }

    case 'SessionReady': {
      if (s.phase.kind !== 'starting') return warn(s, `SessionReady in phase '${s.phase.kind}'`);
      const { queuedPrompts, effects: queueEffects } = dequeuePromptEffects(s.queuedPrompts);
      return {
        state: { ...s, phase: { kind: 'ready' }, queuedPrompts },
        effects: [{ type: 'state' }, ...queueEffects],
      };
    }

    case 'SessionLoaded':
      if (s.phase.kind !== 'replaying') return warn(s, `SessionLoaded in phase '${s.phase.kind}'`);
      return { state: s, effects: [] };

    case 'PromptStarted':
      if (s.phase.kind !== 'ready') return warn(s, `PromptStarted in phase '${s.phase.kind}'`);
      return { state: s, effects: [{ type: 'promptStarted', prompt: ev.prompt }] };

    case 'WorkStarted':
      if (s.phase.kind === 'working' || s.phase.kind === 'cancelling') return { state: s, effects: [] };
      if (s.phase.kind !== 'ready') return warn(s, `WorkStarted in phase '${s.phase.kind}'`);
      return {
        state: {
          ...s,
          phase: { kind: 'working' },
          // 开工 ⇒ 上一次停下的结局不再是「当前」。不清它,连续两次异常停下只会在下游产生一次边沿,
          // 而且之后任何一次 busy→idle 都会被读成「又异常终结了一次」(#4618)。
          lastTurnOutcome: 'none',
        },
        effects: [{ type: 'state' }, { type: 'agentEvent', phase: 'start' }],
      };

    case 'PromptSteered':
      // 插进 agent 正在干的活:状态不变;实际发送由 sendPromptInternal 认这个 effect 标记后同步接手。
      return { state: s, effects: [{ type: 'promptSteered', prompt: ev.prompt }] };

    case 'PromptQueued':
      if (!ev.prompt.origin) {
        throw new Error(`Queued prompt ${ev.prompt.id} has no explicit origin`);
      }
      // ❌ 这里**不**做「空闲就立刻出队」。试过,代价是把 queuePrompt 的语义从「排进去」改成
      // 「排进去顺便发」,于是空闲时排的条目无法编辑/重排 —— 那是 composer 队列带子的既有能力。
      // #4660 的滞留由「失败不回队列」根除(队列只装还没试过的);空闲会话上的队列由**入口**封住(#6762):
      // 产品的排队入口(`SessionCell.queueBehindTurn`)与发送同一个准入,空闲时当场开轮,不落这里。
      // 原样 `QueuePrompt` 只剩启动队列 / 设置闸 / 队列快照恢复在用,它们各有自己的抽干边界。
      {
        // #6387 同键替换:还在排的那条换成新内容,位置与 id 不变(它仍是「那一条」,只是内容新了)。
        const key = ev.prompt.coalesceKey;
        const index = key === undefined
          ? -1
          : s.queuedPrompts.findIndex((prompt) => prompt.coalesceKey === key && !prompt.queueEdit);
        if (index >= 0) {
          const existing = s.queuedPrompts[index];
          const replaced = { ...ev.prompt, id: existing.id, createdAt: existing.createdAt };
          return {
            state: {
              ...s,
              queuedPrompts: s.queuedPrompts.map((prompt, at) => (at === index ? replaced : prompt)),
            },
            effects: [{ type: 'state' }],
          };
        }
      }
      return {
        state: { ...s, queuedPrompts: [...s.queuedPrompts, ev.prompt] },
        effects: [{ type: 'state' }],
      };

    case 'QueuedPromptEdited':
      return {
        state: {
          ...s,
          queuedPrompts: s.queuedPrompts.map((prompt) =>
            prompt.id === ev.id ? applyQueueEdit(prompt, ev) : prompt
          ),
        },
        effects: [{ type: 'state' }],
      };

    case 'QueuedPromptRemoved':
      return {
        state: {
          ...s,
          queuedPrompts: s.queuedPrompts.filter((prompt) => prompt.id !== ev.id),
        },
        effects: [{ type: 'state' }],
      };

    case 'QueueReordered': {
      const byId = new Map(s.queuedPrompts.map((prompt) => [prompt.id, prompt]));
      return {
        state: { ...s, queuedPrompts: ev.ids.map((id) => byId.get(id)!).filter(Boolean) },
        effects: [{ type: 'state' }],
      };
    }

    case 'WorkEnded': {
      if (s.phase.kind !== 'working' && s.phase.kind !== 'cancelling') {
        return warn(s, `WorkEnded in phase '${s.phase.kind}'`);
      }
      const stopReason = ev.outcome.kind === 'stopped' ? ev.outcome.stopReason : null;
      // agent 停下就抽干队列:后台子代理不是在干的活,不挡下一句。
      const { queuedPrompts, effects: queueEffects } =
        ev.dequeueQueuedPrompt !== false
          ? dequeuePromptEffects(s.queuedPrompts)
          : { queuedPrompts: s.queuedPrompts, effects: [] as Effect[] };
      return {
        state: {
          ...s,
          phase: { kind: 'ready' },
          lastStopReason: stopReason,
          // 异常终结在 lastStopReason 里没有档(它是 ACP 协议枚举),所以那条投影成 null。
          // 这一格是**并列**记录「怎么停下的」,让下游能把它与「尚未开始」分开(#4618)。
          lastTurnOutcome: ev.outcome.kind === 'errored' ? 'errored' : 'stopped',
          queuedPrompts,
        },
        effects: [
          { type: 'state' },
          { type: 'agentEvent', phase: ev.outcome.kind === 'errored' ? 'error' : 'stop' },
          { type: 'settleAgents', scope: 'turn', status: 'completed' },
          ...(ev.outcome.kind === 'errored' || stopReason === 'cancelled'
            ? ([{ type: 'settleAgents', scope: 'all', status: 'failed' }] as Effect[])
            : []),
          ...queueEffects,
        ],
      };
    }

    case 'AgentsChanged': {
      const { queuedPrompts, effects: queueEffects } =
        ev.runningCount === 0 && s.phase.kind === 'ready'
          ? dequeuePromptEffects(s.queuedPrompts)
          : { queuedPrompts: s.queuedPrompts, effects: [] as Effect[] };
      return {
        state: { ...s, backgroundAgentCount: ev.runningCount, queuedPrompts },
        effects: [{ type: 'state' }, ...queueEffects],
      };
    }

    case 'BackgroundCommandsChanged':
      return {
        state: { ...s, backgroundCommandTaskIds: ev.taskIds },
        effects: [{ type: 'state' }],
      };

    case 'CancellationRequested': {
      if (s.phase.kind !== 'working' && s.backgroundAgentCount === 0) {
        return warn(s, `CancellationRequested in phase '${s.phase.kind}'`);
      }
      const drainEffects: Effect[] = s.pendingPermissions.map((p) => ({
        type: 'permissionResolved' as const,
        requestId: p.requestId,
        cancelled: true,
      }));
      if (s.phase.kind !== 'working') {
        // 只剩后台在跑:取消的是后台,不是一次停下。
        return {
          state: { ...s, pendingPermissions: [] },
          effects: [
            ...drainEffects,
            { type: 'settleAgents', scope: 'all', status: 'failed' },
            { type: 'state' },
          ],
        };
      }
      return {
        state: { ...s, phase: { kind: 'cancelling' }, pendingPermissions: [] },
        effects: [...drainEffects, { type: 'state' }],
      };
    }

    case 'PermissionRequested':
      return {
        state: { ...s, pendingPermissions: [...s.pendingPermissions, ev.request] },
        effects: [{ type: 'permissionRequest', request: ev.request }],
      };

    case 'PermissionResolved':
      return {
        state: {
          ...s,
          pendingPermissions: s.pendingPermissions.filter((p) => p.requestId !== ev.requestId),
        },
        effects: [{ type: 'permissionResolved', requestId: ev.requestId, cancelled: false }],
      };

    case 'SettingsReady': {
      if (s.phase.kind !== 'ready') return warn(s, `SettingsReady in phase '${s.phase.kind}'`);
      const { queuedPrompts, effects: queueEffects } = dequeuePromptEffects(s.queuedPrompts);
      return {
        state: { ...s, queuedPrompts },
        effects: [{ type: 'state' }, ...queueEffects],
      };
    }

    case 'ProcessClosed': {
      const drainEffects: Effect[] = s.pendingPermissions.map((p) => ({
        type: 'permissionResolved' as const,
        requestId: p.requestId,
        cancelled: true,
      }));
      return {
        state: {
          ...s,
          phase: ev.abnormal === false
            ? { kind: 'closed', exitCode: ev.exit.exitCode }
            : { kind: 'lost', failure: adapterExitFailure(ev.exit) },
          failure: ev.abnormal === false ? null : adapterExitFailure(ev.exit),
          pendingPermissions: [],
        },
        effects: [
          ...drainEffects,
          { type: 'settleAgents', scope: 'all', status: 'failed' },
          { type: 'state' },
          { type: 'closed', exitCode: ev.exit.exitCode },
        ],
      };
    }
  }
}

function warn(
  s: SessionMachineState,
  message: string
): { state: SessionMachineState; effects: Effect[] } {
  return { state: s, effects: [{ type: 'warn', message }] };
}

function applyQueueEdit(prompt: QueuedPrompt, event: Extract<DomainEvent, { type: 'QueuedPromptEdited' }>): QueuedPrompt {
  const { queueEdit: previous, ...rest } = prompt;
  const queueEdit = event.queueEdit === undefined ? previous : event.queueEdit;
  return { ...rest, ...event.input, updatedAt: event.updatedAt, ...(queueEdit ? { queueEdit } : {}) };
}


/**
 * @@@按来源抽干 - manual 是一条一轮；其它来源保留自己的批次语义。
 *
 * manual 只取队首一条。其它来源取队首那段**同类的连续条目**一次发出:
 * 三条 typed ⇒ provider 收一条;回合里攒下的三条投递信封 ⇒ 也只收一条
 * (#4652,owner:几十个 agent 辩论时队列要一次抽干)。
 *
 * ⚠️ machine 只决定**哪些条目一起出队**(队列策略),❌ 不决定它们的字节怎么拼 ——
 * 那是 cell 的事,因为信封合并的唯一属主 `mergeDeliveryEnvelopes` 住在 core,
 * 由宿主经 cell-deps 注入。在这里复制信封语义 = #4429 删掉的第二属主。
 */

function dequeuePromptEffects(queuedPrompts: readonly QueuedPrompt[]): {
  queuedPrompts: readonly QueuedPrompt[];
  effects: Effect[];
} {
  const [head] = queuedPrompts;
  if (!head || head.queueEdit) return { queuedPrompts, effects: [] };
  const kind = mergeKind(head);
  let end = 1;
  if (kind !== 'alone') {
    while (end < queuedPrompts.length && !queuedPrompts[end].queueEdit && mergeKind(queuedPrompts[end]) === kind) end += 1;
  }
  const sources = queuedPrompts.slice(0, end);
  return {
    queuedPrompts: queuedPrompts.slice(end),
    effects: [{ type: 'sendPrompt', sources }],
  };
}

/**
 * 一个条目能和谁并作一轮。**两个排除项的理由互不相干,所以分开写、分开判** ——
 * 它们曾经挤在同一个判别式里,结果 owner 只要求反转其中一条时,另一条差点被顺手一起反掉(#4652)。
 *
 * - `'alone'`(manual 或带附件):manual 按用户输入顺序一条一轮；附件的图片在 provider 请求里
 *   排在正文之前,几条各带一张图拼起来 ⇒ 图全堆在
 *   合并正文前面,**图↔文对不上号**。这条与"辩论消息该不该合"正交;要折叠附件得先解决图文归属,
 *   那是另一个问题。⇒ 单走一轮。
 * - `'typed'` / `'envelope'`:两类都合并,但**不互相混**。typed 是这个会话里原样发出、不带投递信封
 *   的正文;envelope 带 per-message 归因(from/chat/msg)。把两者拼进同一条会让人说的话和投递事实
 *   分不开,所以只在同类之间连成一段。
 */
type MergeKind = 'alone' | 'typed' | 'envelope';

function mergeKind(prompt: QueuedPrompt): MergeKind {
  if (prompt.origin === 'manual' || prompt.attachments?.length) return 'alone';
  return prompt.origin === 'typed' ? 'typed' : 'envelope';
}

export function queuedPromptMergeKind(prompt: QueuedPrompt): MergeKind {
  return mergeKind(prompt);
}

/**
 * typed 那类的拼法:正文之间只放一个空行,自己不添一个字 —— 按 spec delivery-routing
 * 「缺席信封就是当面标记」。信封那类**不走这里**,走宿主注入的唯一属主。
 */
export function mergeTypedPrompts(sources: readonly QueuedPrompt[]): QueuedPrompt {
  const [head] = sources;
  if (sources.length === 1) return head;
  const join = (parts: readonly (string | undefined)[]): string =>
    parts.filter((part): part is string => !!part?.trim()).join('\n\n');
  const hiddenContext = join(sources.map((prompt) => prompt.hiddenContext));
  return {
    id: head.id,
    origin: 'typed',
    text: join(sources.map((prompt) => prompt.text)),
    ...(hiddenContext ? { hiddenContext } : {}),
    createdAt: head.createdAt,
    updatedAt: Math.max(...sources.map((prompt) => prompt.updatedAt)),
  };
}

/** agent 在不在干活。后台子代理不算(park)。 */
export function isBusy(s: SessionMachineState): boolean {
  return s.phase.kind === 'working' || s.phase.kind === 'cancelling';
}

export function isPromptReady(lifecycle: SessionLifecycle): boolean {
  return lifecycle === 'ready';
}

export function projectSessionState(
  s: SessionMachineState,
  activeTurnId: string | null,
): SessionState {
  const lifecycle = phaseToLifecycle(s.phase);
  const isGenerating = isBusy(s) || s.backgroundAgentCount > 0;
  return {
    lifecycle,
    activeTurnId,
    pendingPermissions: structuredClone([...s.pendingPermissions]),
    lastStopReason: s.lastStopReason,
    lastTurnOutcome: s.lastTurnOutcome,
    queuedPrompts: structuredClone([...s.queuedPrompts]),
    backgroundAgentCount: s.backgroundAgentCount,
    backgroundCommandCount: s.backgroundCommandTaskIds.length,
    backgroundCommandTaskIds: [...s.backgroundCommandTaskIds],
    isGenerating,
    canSubmit: isPromptReady(lifecycle),
    canCancel: s.phase.kind === 'working' || s.backgroundAgentCount > 0,
    failure: s.failure,
  };
}

export class SessionMachine {
  private _state: SessionMachineState;

  constructor(sessionId: string) {
    this._state = initialMachineState(sessionId);
  }

  get phase(): SessionPhase {
    return this._state.phase;
  }
  get lifecycle(): SessionLifecycle {
    return phaseToLifecycle(this._state.phase);
  }
  get pendingPermissions(): readonly AcpPermissionRequest[] {
    return this._state.pendingPermissions;
  }
  get lastStopReason(): StopReason | null {
    return this._state.lastStopReason;
  }
  get queuedPrompts(): readonly QueuedPrompt[] {
    return this._state.queuedPrompts;
  }
  get backgroundAgentCount(): number {
    return this._state.backgroundAgentCount;
  }
  get isWorking(): boolean {
    return this._state.phase.kind === 'working' || this._state.phase.kind === 'cancelling';
  }
  get canSubmit(): boolean {
    return isPromptReady(this.lifecycle);
  }
  get canCancel(): boolean {
    return this._state.phase.kind === 'working' || this._state.backgroundAgentCount > 0;
  }
  get isGenerating(): boolean {
    return this.isWorking || this._state.backgroundAgentCount > 0;
  }

  dispatch(
    cmd: Command,
    ctx: SessionMachineContext = emptySessionMachineContext()
  ): Result<Effect[], AcpRuntimeError> {
    const decision = decide(this._state, cmd, ctx);
    if (!decision.success) return decision;
    const allEffects: Effect[] = [];
    for (const event of decision.data) {
      const { state, effects } = evolve(this._state, event);
      this._state = state;
      allEffects.push(...effects);
    }
    return ok(allEffects);
  }

  apply(...events: DomainEvent[]): Effect[] {
    const allEffects: Effect[] = [];
    for (const event of events) {
      const { state, effects } = evolve(this._state, event);
      this._state = state;
      allEffects.push(...effects);
    }
    return allEffects;
  }

  /** `activeTurnId` 是转录里正开着的那一组(展示用的分组,由 cell 给),❌ 不是状态机的东西。 */
  sessionState(activeTurnId: string | null): SessionState {
    return projectSessionState(this._state, activeTurnId);
  }
}
// The state machine for the ACP Session

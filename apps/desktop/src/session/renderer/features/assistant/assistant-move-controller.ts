// #7199 助理搬家 · 一次搬的状态与动作(模块级,不属于任何一个 React 组件)。
// 为什么不放在设置行的组件里:搬到中途「它住哪」翻面,设置页上画搬家那一组的位置会换(云上的状态组 ↔ 住电脑的几组),
// 组件被卸载重挂,放在组件里的弹窗状态就丢了 —— 人看见弹窗凭空消失、搬家却还在跑。状态放这里,弹窗挂在壳上(AssistantShellHost),
// 设置行只负责发起和显示「接着搬」。同一时刻只有一次搬。
import { CloudComputerError } from '@gugu/core/cloud/cloudComputer';
import { rendererLogger } from '@/lib/log';
import { rpcOn } from '@renderer/lib/ipc';
import { homeTarget } from './assistant-home-sessions';
import { MoveError, type MoveDirection, type MoveProgress, type MoveReport } from './assistant-move';
import { MoveCopyError } from './assistant-move-copy';
import { previewMove, runAssistantMove, type MoveEnv } from './assistant-move-wire';

const log = rendererLogger('assistant/move');

export type MovePreview = Awaited<ReturnType<typeof previewMove>>;

export type MoveFailureReason =
  | 'plan_required'
  | 'credits_exhausted'
  | 'already_exists'
  | 'already_there'
  | 'unsupported'
  | 'too_large'
  | 'file_too_large'
  | 'unreadable'
  | 'generic';

export type MovePhase =
  | { kind: 'idle' }
  | { kind: 'preparing'; direction: MoveDirection }
  | { kind: 'confirm'; direction: MoveDirection; preview: MovePreview; names: Map<string, string> }
  | { kind: 'moving'; direction: MoveDirection; progress: MoveProgress | null }
  | { kind: 'done'; direction: MoveDirection; report: MoveReport; names: Map<string, string> }
  | { kind: 'failed'; direction: MoveDirection; reason: MoveFailureReason; resumable: boolean; intact: boolean }
  | { kind: 'prepare-failed'; direction: MoveDirection };

export type MoveState = {
  phase: MovePhase;
  /** 弹窗里称呼它用的名字(开搬那一刻的)。 */
  assistantName: string;
  /** 这一次搬用的环境:弹窗里「再试一次 / 接着搬」要用同一份。 */
  env: MoveEnv | null;
  language: string;
};

const IDLE: MoveState = { phase: { kind: 'idle' }, assistantName: '', env: null, language: 'zh-CN' };
let state: MoveState = IDLE;
const listeners = new Set<() => void>();

function publish(next: Partial<MoveState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function getMoveState(): MoveState {
  return state;
}

export function subscribeMove(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 一次搬正占着(预览中 / 搬着):再点别的搬 = 不理。 */
export function moveBusy(): boolean {
  return state.phase.kind === 'preparing' || state.phase.kind === 'moving';
}

export function failureReason(error: unknown): MoveFailureReason {
  const cause = error instanceof MoveError ? error.cause : error;
  if (cause instanceof MoveCopyError) {
    return cause.code === 'file_too_large' ? 'file_too_large' : cause.code === 'too_large' ? 'too_large' : cause.code === 'unreadable' ? 'unreadable' : 'generic';
  }
  if (cause instanceof CloudComputerError) {
    switch (cause.code) {
      case 'plan_required':
      case 'credits_exhausted':
      case 'already_exists':
      case 'already_there':
        return cause.code;
      case 'agent_type_unsupported':
        return 'unsupported';
    }
  }
  return 'generic';
}

/** 点「搬到云上 / 搬回这台电脑」:先读旧家、列清会带走什么,等人确认。只读。 */
export async function startPreview(env: MoveEnv, direction: MoveDirection, language: string): Promise<void> {
  if (moveBusy()) return;
  publish({ phase: { kind: 'preparing', direction }, assistantName: env.assistantName, env, language });
  try {
    const [preview, list] = await Promise.all([
      previewMove(env, direction),
      rpcOn(homeTarget(env.home)).integrations.list(language).catch(() => [] as { id: string; name: string }[]),
    ]);
    publish({ phase: { kind: 'confirm', direction, preview, names: new Map(list.map((item) => [item.id, item.name])) } });
  } catch (error) {
    log.warn({ error: String(error), direction }, 'move preview failed');
    publish({
      phase:
        error instanceof MoveError || error instanceof MoveCopyError
          ? { kind: 'failed', direction, reason: failureReason(error), resumable: false, intact: true }
          : { kind: 'prepare-failed', direction },
    });
  }
}

/** 人点了「开始搬家」/「接着搬」:搬在后台跑完,弹窗跟着这里的状态走。 */
export async function startMove(env: MoveEnv, direction: MoveDirection, names: Map<string, string>, language: string): Promise<void> {
  if (moveBusy()) return;
  publish({ phase: { kind: 'moving', direction, progress: null }, assistantName: env.assistantName, env, language });
  try {
    const report = await runAssistantMove(env, direction, (progress) => publish({ phase: { kind: 'moving', direction, progress } }));
    // 没收好的几件事原因只进日志(文案只说「不影响使用」)
    for (const detail of report.warnings) log.warn({ detail, direction }, 'move finished with a warning');
    publish({ phase: { kind: 'done', direction, report, names } });
  } catch (error) {
    log.error({ error: String(error), direction }, 'move failed');
    const intact = error instanceof MoveError ? error.sourceIntact : false;
    publish({ phase: { kind: 'failed', direction, reason: failureReason(error), resumable: !intact, intact } });
  }
}

/** 关掉弹窗(预览 / 搬着时不能关,由界面守)。 */
export function dismissMove(): void {
  if (moveBusy()) return;
  publish({ phase: { kind: 'idle' } });
}

/** 单测用:回到初始。 */
export function resetMoveForTests(): void {
  state = IDLE;
  for (const listener of listeners) listener();
}

import type { MeasureCtx } from '@session-chat/core/define';
import type { ChatMessage } from '@session-chat/model';
import { formatElapsed } from '@session-chat/lib/format-elapsed';
import { backgroundTasksLabel } from '../background-tasks/background-tasks-parts';
import { readableLabel, rowTranslator } from '../readable-label';

type Process = NonNullable<ChatMessage['conversationProcess']>;

export function processSummary(process: Process, translate: ReturnType<typeof rowTranslator>, elapsed: string | null) {
  const steps = process.steps ? translate(process.steps === 1 ? 'transcript.processStepsOne' : 'transcript.processSteps', { count: process.steps }) : null;
  return [elapsed, steps].filter(Boolean).join(' · ');
}

export function processButtonLayout(process: Process, ctx: MeasureCtx) {
  const translate = rowTranslator(ctx);
  const knownTime = Number.isFinite(process.startedAt) && (process.live || Number.isFinite(process.endedAt));
  // A stable timer slot keeps ticks in the presentation lane. This is geometry only, never displayed time.
  const elapsed = !knownTime ? null : process.live ? '999h59m' : formatElapsed(Math.max(0, process.endedAt! - process.startedAt! - (process.idleMs ?? 0)));
  const text = [process.live ? translate('transcript.thinkingLive') : null, processSummary(process, translate, elapsed)].filter(Boolean).join(' · ');
  const label = readableLabel(text, ctx, ctx.width - 40, 12, 22, 400, true);
  return { width: Math.min(ctx.width, label.width + 40), height: label.height };
}

export function backgroundPillLayout(ownerId: string, ctx: MeasureCtx) {
  const bg = ctx.background;
  if (!bg || bg.ownerId !== ownerId) return null;
  const label = readableLabel(backgroundTasksLabel(rowTranslator(ctx), bg.commands.length, bg.subagents.length), ctx, ctx.width - 36, 12, 22, 400, true);
  return { ...label, width: Math.min(ctx.width - 19, label.width + 17) };
}

export function processRowHeight(ownerId: string, process: Process, ctx: MeasureCtx) {
  const button = processButtonLayout(process, ctx);
  const bg = backgroundPillLayout(ownerId, ctx);
  return !bg ? button.height : button.width + bg.width + 19 <= ctx.width
    ? Math.max(button.height, bg.height) : button.height + bg.height;
}

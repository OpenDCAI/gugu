/** @jsxImportSource solid-js */
import type { ChatCommands } from '@session-chat/commands';
import type { MeasureCtx } from '@session-chat/core/define';
import type { TranscriptTurnOutcome } from '@session-chat/model';
import { useChatTranslator } from '@session-chat/localization';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { vars } from '@session-chat/styles/theme.css';
import { Show } from 'solid-js';
import { readableLabel, rowTranslator } from '../readable-label';

/** Only the gateway's own refusal is evidence that credits interrupted this turn. */
export function isCreditExhaustion(outcome: TranscriptTurnOutcome): boolean {
  if (outcome.kind !== 'error' || outcome.signInRequired) return false;
  const text = outcome.said ?? '';
  if (/^(?:咕咕积分用完了|这个账号还没有咕咕积分)[。！]/.test(text)) return true;
  const detail = outcome.detail ?? '';
  return /["']code["']\s*:\s*["'](?:credits_exhausted|no_credits)["']/.test(detail)
    && /咕咕积分|Gugu credits/i.test(detail);
}

export function creditExhaustionLayout(ctx: MeasureCtx, commands?: ChatCommands) {
  const t = rowTranslator(ctx);
  const message = t('transcript.creditsExhausted');
  const action = commands?.onRechargeCredits ? t('transcript.rechargeCredits') : '';
  const body = ctx.theme.config.roles.body;
  const label = readableLabel(`${message}${action ? ` ${action}` : ''}`, ctx, ctx.width, body.size, body.lineHeight, body.weight);
  return { ...label, message: action ? label.text.slice(0, -action.length) : label.text, action };
}

/** One ordinary body row replaces the failure badge, warning color, and duplicate explanation. */
export function CreditExhaustionRow(props: { outcome: TranscriptTurnOutcome; ctx: () => MeasureCtx }) {
  const commands = useCommands();
  const translate = useChatTranslator();
  const layout = () => creditExhaustionLayout({ ...props.ctx(), translate }, commands());
  return <div data-slot="turn-outcome" data-outcome="error" data-credit-exhausted=""
    style={{ height: `${layout().height}px`, color: vars.fgBody, 'font-family': vars.typeBodyFontFamily,
      'font-size': vars.typeBodyFontSize, 'font-weight': vars.typeBodyFontWeight, 'line-height': vars.typeBodyLineHeight,
      'white-space': 'pre-wrap', 'overflow-wrap': 'normal', 'word-break': 'normal', 'user-select': 'text' }}>
    {layout().message}<Show when={layout().action}>
      <button type="button" data-slot="credit-recharge" onClick={() => commands().onRechargeCredits?.()}
        style={{ border: 'none', padding: 0, background: 'transparent', color: 'inherit', font: 'inherit', 'text-decoration': 'underline', cursor: 'pointer' }}>
        {layout().action}
      </button>
    </Show>
  </div>;
}

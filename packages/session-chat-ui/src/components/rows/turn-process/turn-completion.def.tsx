/** @jsxImportSource solid-js */
import { CopyButton } from '@session-chat/components/primitives/CopyButton';
import { defineUnit } from '@session-chat/core/units';
import type { TurnCompletionItem } from '@session-chat/model';
import { completionActions } from './turn-completion.css';
import { Show } from 'solid-js';

export const turnCompletionUnitDef = defineUnit<TurnCompletionItem, { height: number }>({
  kind: 'turn-completion',
  margin: { top: 4, bottom: 4 },
  vars: { height: 24 },
  measure(_data, _ctx, vars) { return vars.height; },
  Render(props) {
    return (
      <div class={completionActions} data-slot="turn-completion" data-turn-id={props.data.turnId} style={{ height: `${props.vars.height}px` }}>
        <Show when={props.data.id} keyed>
          {(_id) => <CopyButton text={props.data.text} variant="inline" labelKey="transcript.copyTurnResult" />}
        </Show>
      </div>
    );
  },
});

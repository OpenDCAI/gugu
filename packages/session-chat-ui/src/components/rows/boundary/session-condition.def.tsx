/** @jsxImportSource solid-js */
/**
 * session-condition —— 这条会话**此刻**的状态，贴在消息列表最后一行
 * （spec `session-always-openable`）。
 *
 * # 它替换掉了什么
 *
 * 此前这些状态各自占一张**整屏不透明错误页**（`acp-chat-panel.tsx` 里那个 `inset-0` 覆盖层，
 * 7 种分支）。那张页把已经画好的聊天记录整块盖住 —— 用户连自己昨天说过什么都看不到。
 * owner 2026-09-19 的裁决：
 *
 * > 任何 bug 都不应该让会话打不开才对吧,也不应该有任何需要横幅性质的 ui 表达,
 * > 有问题就像消息一样贴消息列表才对吧.
 *
 * # 为什么不是转录条目
 *
 * 寿命不同，见 `SessionConditionItem` 抬头：条件消失这一行就该消失。
 * ❌ 别为了「留个痕」把它写进历史 —— 那会让装好引擎之后，对话里永远挂着一句「没装」。
 * 真正该留痕的那些事（模型没了、上下文被重开）走 `session-notice` / `context-reset`。
 *
 * # 动作是句子里的一段字
 *
 * ❌ 不在行底下单独摆一颗按钮 —— owner 对那种形态的原话是「你这样搞得很突兀」。
 * 没有可做的事就只说事实（例如引擎正在更新：等几秒它自己就好了）。
 */
import { For } from 'solid-js';
import { defineUnit } from '@session-chat/core/units';
import { useChatTranslator } from '@session-chat/localization';
import type { SessionConditionItem } from '@session-chat/model';
import { boundaryAction, boundaryLabel, boundaryRow, boundaryRule } from './boundary.css';

/** 行高（px）。与 `compaction` / `context-reset` / 日界行同一个解剖。 */
export const SESSION_CONDITION_ROW_H = 24;

const LABEL_KEY: Record<SessionConditionItem['code'], string> = {
  'harness-missing': 'transcript.condition.harnessMissing',
  'harness-updating': 'transcript.condition.harnessUpdating',
  'auth-required': 'transcript.condition.authRequired',
  'provider-session-missing': 'transcript.condition.providerSessionMissing',
  'adapter-lost': 'transcript.condition.adapterLost',
  'start-failed': 'transcript.condition.startFailed',
  'machine-unreachable': 'transcript.condition.machineUnreachable',
  'machine-attention': 'transcript.condition.machineAttention',
  'membership-required': 'transcript.condition.membershipRequired',
};

export const sessionConditionUnitDef = defineUnit<SessionConditionItem, { rowH: number }>({
  kind: 'session-condition',
  margin: { top: 16, bottom: 12 },
  vars: { rowH: SESSION_CONDITION_ROW_H },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    const translate = useChatTranslator();
    const label = (): string =>
      props.data.label ??
      translate(
        props.data.code === 'provider-session-missing' && props.data.hasVisibleHistory
          ? 'transcript.condition.providerSessionMissingWithHistory'
          : LABEL_KEY[props.data.code],
        props.data.labelValues
      );

    return (
      <div
        data-slot="session-condition"
        data-condition-code={props.data.code}
        role="status"
        aria-label={label()}
        class={boundaryRow}
        // 排查要的是运行时那句原文,给鼠标停留看得到,而不摊在正文里。
        // 标签窄时会收成省略号(boundary.css.ts),所以把整句放在原文前面。
        title={`${label()}\n${props.data.detail}`}
        style={{ height: `${props.vars.rowH}px` }}
      >
        <span data-slot="session-condition-rule" aria-hidden="true" class={boundaryRule} />
        <span data-slot="session-condition-label" class={boundaryLabel}>
          {label()}
        </span>
        <For each={props.data.actions ?? []}>
          {(action) => (
            <button
              type="button"
              data-slot="session-condition-action"
              class={boundaryAction}
              onClick={() => action.run()}
            >
              {action.label}
            </button>
          )}
        </For>
        <span data-slot="session-condition-rule" aria-hidden="true" class={boundaryRule} />
      </div>
    );
  },
});

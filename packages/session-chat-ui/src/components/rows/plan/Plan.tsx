/** @jsxImportSource solid-js */
import { BlockStackView } from '@session-chat/components/primitives/BlockStackView';
import {
  PlanCompletedIcon,
  PlanInProgressIcon,
  PlanPendingIcon,
} from '@session-chat/components/primitives/icons';
import { Match, Switch, For } from 'solid-js';
import type { PlanEntryPriority, PlanEntryStatus } from '@session-chat/model';
import type { PlanEntryLaid } from './plan.def';
import { planVars } from './plan.css';
import { vars } from '@session-chat/styles/theme.css';

// ── Status glyph helpers ──────────────────────────────────────────────────────

/**
 * 三档 = 一条明度阶梯 + 唯一的那个蓝。
 *
 * ⚠️ 2026-09-22 按 design.md 统一。原来是 `completed` 绿(#22c55e)、`in_progress`
 * 琥珀(#f59e0b),两个色相各写了一份裸 hex 当兜底。design.md:「One accent at a time,
 * and the accent is blue. blue-500 means live: streaming, **running**, connected …」
 * ⇒ 在做的那一条是全屏唯一的 live,做完的那些退成墨色的一档(它们不需要自己的色相,
 * 「做完」本来就该往后退),还没做的仍然最淡。
 * 兜底的裸 hex 一并删掉 —— 取值走契约,契约里两套主题都有值。
 */
function statusColor(status: PlanEntryStatus): string {
  if (status === 'completed') return vars.fgMuted;
  if (status === 'in_progress') return vars.live;
  return vars.fgPassive;
}

function priorityOpacity(priority: PlanEntryPriority): string {
  if (priority === 'low') return '0.55';
  return '1';
}

// ── PlanList ──────────────────────────────────────────────────────────────────

export type PlanListProps = {
  entries: PlanEntryLaid[];
};

export function PlanList(props: PlanListProps) {
  return (
    <div
      style={{
        'padding-top': planVars.padY,
        'padding-bottom': planVars.padY,
      }}
    >
      <For each={props.entries}>
        {(entry, i) => (
          <div
            style={{
              display: 'flex',
              'align-items': 'flex-start',
              'column-gap': planVars.iconGap,
              'margin-top': i() > 0 ? planVars.entryGap : '0',
              opacity: priorityOpacity(entry.priority),
            }}
          >
            <div
              style={{
                width: planVars.iconBox,
                // Line-height the engine measured with, not a literal: a theme
                // whose body line-height is not 20px would otherwise make the
                // glyph column taller than the text it sits beside.
                height: planVars.lineH,
                'flex-shrink': '0',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                color: statusColor(entry.status),
                'user-select': 'none',
              }}
              aria-label={entry.status.replace('_', ' ')}
            >
              <Switch>
                <Match when={entry.status === 'completed'}>
                  <PlanCompletedIcon />
                </Match>
                <Match when={entry.status === 'in_progress'}>
                  <PlanInProgressIcon />
                </Match>
                <Match when={entry.status === 'pending'}>
                  <PlanPendingIcon />
                </Match>
              </Switch>
            </div>
            <div style={{ flex: '1' }}>
              <BlockStackView node={entry.measured} />
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

import { LoadingIndicator } from '../loading-indicator/LoadingIndicator';
/**
 * Agent（harness）选择器 —— 底排右组里排在模型触发器**前面**的那颗。
 *
 * 从 `index.tsx` 拆出来（#4981 A1，理由见 `composer-options.ts` 顶部）。整段原样搬运：
 * `data-testid="composer-agent-trigger"` / `composer-agent-option-*` / `composer-agent-search`
 * 都是既有测试的锚点，一个字符都没动。
 *
 * ⚠️ 顺序是 owner 指定的：先 Harness 后模型。❌ 不把 agent 并进模型触发器的图标里 ——
 * 咕咕要 Harness 先被显式选出来。
 */
import { Button } from '@session-ui/react/primitives/button';

import type React from 'react';
import { useState } from 'react';
import { Combobox } from '@session-ui/react/primitives/combobox/combobox';
import { Search } from '../../../icons';
import * as styles from './chat-composer.css';
import type { ComposerAgentOption } from './composer-options';

/**
 * 智能体名单还在路上(典型:问的是另一台机器,要跨云往返)时,这一格画一枚不可点的「正在读取」占位 ——
 * ❌ 不让这一格凭空消失,用户会以为这台机器上什么都开不了。
 */
export function ComposerAgentLoading({ label, title }: { label: string; title: string }) {
  return (
    <span role="status" className={styles.agentTrigger} data-testid="composer-agent-loading" title={title}>
      <LoadingIndicator size="inline" />
      <span className={styles.agentTriggerLabel}>{label}</span>
    </span>
  );
}

export interface AgentGroup {
  label: string;
  items: ComposerAgentOption[];
}

export function buildAgentGroups(options: ComposerAgentOption[]): AgentGroup[] {
  const grouped = new Map<string, ComposerAgentOption[]>();
  for (const opt of options) {
    const label = opt.groupLabel ?? '';
    const existing = grouped.get(label);
    if (existing) {
      existing.push(opt);
    } else {
      grouped.set(label, [opt]);
    }
  }
  return Array.from(grouped.entries()).map(([label, items]) => ({ label, items }));
}

export interface ComposerAgentSelectorProps {
  options: ComposerAgentOption[];
  selectedId?: string;
  onSelect: (agentId: string) => void;
  onAction?: (agentId: string) => void;
  locked?: boolean;
  disabled?: boolean;
  label: string;
  searchPlaceholder: string;
  lockedLabel?: string;
  optionTestIdPrefix?: string;
  searchTestId?: string;
  popupZIndex?: React.CSSProperties['zIndex'];
}

export function ComposerAgentSelector({
  options,
  selectedId,
  onSelect,
  onAction,
  locked = false,
  disabled = false,
  label,
  searchPlaceholder,
  lockedLabel,
  optionTestIdPrefix,
  searchTestId,
  popupZIndex,
}: ComposerAgentSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected = selectedId ? (options.find((o) => o.id === selectedId) ?? null) : null;
  const groups = buildAgentGroups(options);
  const isDisabled = disabled || locked;

  const triggerLabel = locked ? (lockedLabel ?? selected?.name ?? label) : (selected?.name ?? label);

  // When locked or session closed, show a static disabled icon button.
  if (isDisabled) {
    return (
      <Button
        variant="ghost"
        size="sm"
        icon
        disabled
        className={locked ? styles.agentLockedIndicator : undefined}
        aria-label={triggerLabel}
        title={triggerLabel}
      >
        {selected?.icon ?? <span style={{ width: '0.875rem', height: '0.875rem' }} />}
      </Button>
    );
  }

  return (
    <Combobox.Root
      // @@@task-fusion (#2802) — `items` 必须传:Combobox 的 `filter` 只作用于**它自己持有的
      // items**。从前这里不传 items、自己 `groups.map` 手写列表,于是「Search agents」框能打字
      // 但一行都不过滤(owner 实遇;实测打 grok 仍是 34 行)。设置页那套选择器一直传 items +
      // Collection,所以那边搜得动 —— 这里跟它对齐。
      items={groups}
      value={selected ?? null}
      onValueChange={(item: ComposerAgentOption | null) => {
        if (!item || item.disabled) return;
        // 带 action 的行(没装的 agent)点下去是**去安装**,不是选中它;弹层留着不关,
        // 让安装进行态就在原地显示。
        if (item.action) {
          onAction?.(item.id);
          return;
        }
        onSelect(item.id);
        setOpen(false);
      }}
      open={open}
      onOpenChange={(next) => setOpen(next)}
      isItemEqualToValue={(a: ComposerAgentOption, b: ComposerAgentOption) => a.id === b.id}
      filter={(item: ComposerAgentOption, query: string) =>
        item.name.toLowerCase().includes(query.toLowerCase())
      }
      autoHighlight
    >
      <Combobox.Trigger
        aria-label={label}
        title={triggerLabel}
        className={styles.agentTrigger}
        data-testid="composer-agent-trigger"
      >
        {/* 无图标 agent(如未选态「智能体」)兜底空占位,与 :456 锁定态一致 —— ❌ 灰底占位块
            (owner 真机反馈灰点难看);图标列宽度仍预留,切换有/无图标 agent 时标签不跳。 */}
        {selected?.icon ?? <span style={{ width: '0.875rem', height: '0.875rem' }} />}
        {/* 触发器只显示第一个词(如 'Claude Code' → 'Claude')保持紧凑 —— 大家都认得;
            完整名仍在下拉列表与 hover tooltip(triggerLabel)里。 */}
        <span className={styles.agentTriggerLabel}>
          {selected ? selected.name.split(' ')[0] : label}
        </span>
        {/* ❌ 不画下拉箭头 —— 见 composer-model-menu.tsx 的 @@@composer-no-chevron。 */}
      </Combobox.Trigger>
      {/* 宽度是量出来的,不是拍脑袋:没装的行末尾有个「安装」动作,它静息时 opacity 0(见
          agentRowAction),但**仍然占布局宽度** —— 只加到 11.75rem 时最长的名字还差 34px,
          「Command Code」又被截成「Comman…」。14.5rem 才放得下「名字 + 那条不可见的动作留白」。
          名字后面若还挂着常驻的「Beta」标(#6335),同一行再多出标签那一截(约 2.75rem),
          不加宽就轮到「Antigravity」被截成「Antigr…」—— 所以按清单里有没有标来定宽。 */}
      <Combobox.Content
        // 面板自己不留内距 —— 与模型/权限面板同一族,见 @@@composer-panel-row。
        className={styles.composerPanelContent}
        style={{ minWidth: options.some((o) => o.badge) ? '17.25rem' : '14.5rem' }}
        positionerStyle={popupZIndex === undefined ? undefined : { zIndex: popupZIndex }}
      >
        <Combobox.Input
          showTrigger={false}
          // 与模型面板同一枚放大镜(上游 CommandInput 自带)—— 少了它这一格看着像个普通文本框,
          // 而旁边那个面板有,三个面板一排点开就是三种长相(owner 2026-09-07「不搭」)。
          leftAddon={<Search />}
          aria-label={searchPlaceholder}
          data-testid={searchTestId}
          placeholder={searchPlaceholder}
        />
        <Combobox.List>
          {(group: AgentGroup) => (
            <Combobox.Group key={group.label} items={group.items}>
              {group.label && <Combobox.Label>{group.label}</Combobox.Label>}
              <Combobox.Collection>
                {(item: ComposerAgentOption) => (
                  <Combobox.Item
                    key={item.id}
                    value={item}
                    disabled={item.disabled}
                    // 与模型/权限面板同一族的行 —— 见 chat-composer.css.ts 的 @@@composer-panel-row。
                    // ⚠️ 类名挂在 Item 自己身上:内距是原语给的,写在里面那层会叠成双份。
                    className={styles.composerPanelItem}
                    data-testid={optionTestIdPrefix ? `${optionTestIdPrefix}-${item.id}` : undefined}
                  >
                    {/* ❌ 别退回内联 style:名字那一格原来没有字重、也不定色,而模型面板那边是
                        medium + 正文色 —— 两套写法正是"三个面板三种长相"的来源。 */}
                    {item.icon && <span className={styles.composerPanelItemIcon}>{item.icon}</span>}
                    <span className={styles.composerPanelItemText}>
                      <span className={styles.composerPanelItemName}>{item.name}</span>
                    </span>
                    {item.badge && <span className={styles.agentRowBadge}>{item.badge}</span>}
                    {/* 行动作(目前只有「安装」)。静息时不显示 —— 32 行各挂一枚同样的标签是
                        噪声;指到哪行、或那行正在安装,才把它显出来。 */}
                    {item.action && (
                      <span className={styles.agentRowAction} data-busy={item.action.busy || undefined}>
                        {item.action.busy ? item.action.busyLabel : item.action.label}
                      </span>
                    )}
                  </Combobox.Item>
                )}
              </Combobox.Collection>
            </Combobox.Group>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox.Root>
  );
}

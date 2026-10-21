import { ChevronDown, ChevronUp, Pencil, Plus, TextInitial, Trash2 } from '@/lib/icons'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { commandRegistry } from '@renderer/lib/commands/registry';
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@renderer/lib/ui/combobox';
import { Button } from '@renderer/lib/ui/button';
import { BoundShortcut, Shortcut } from '@renderer/lib/ui/shortcut';
import { cn } from '@renderer/utils/utils';
import { SESSION_COMMAND_DEFS } from '@shared/commands';
import { ProviderLogo } from '@renderer/features/integrations/provider-logo';
import { usePromptLibraryActions } from '@renderer/features/library/prompts/use-prompt-library-actions';
import { buildContextActionText, type ContextAction } from '../context-bar/context-actions';
import { parsePromptDraft, type PromptDraft } from './parse-prompt-draft';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

const ADD_CONTEXT_COMMAND = SESSION_COMMAND_DEFS.find((def) => def.id === 'session.addContext')!;

/**
 * 列表里的一行。多出来的 `create-prompt` 是**打出来的那一行**:一条现有条目都匹配不上时,
 * 列表位置就变成这条新建预览,回车即建立并塞进输入框(owner 2026-09-10 定的交互)。
 * 它跟真条目走同一条选中路径,所以键盘上不必为它另开一套 —— ❌ 别做成一个只有鼠标点得到的按钮。
 */
type CreatePromptRow = { kind: 'create-prompt'; id: string; draft: PromptDraft };
type PopoverRow = ContextAction | CreatePromptRow;

function isCreateRow(row: PopoverRow | null): row is CreatePromptRow {
  return row?.kind === 'create-prompt';
}

function CreatePromptRowView({ draft }: { draft: PromptDraft }) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex h-5 w-full min-w-0 items-center gap-4">
      <div className="flex items-center gap-1.5">
        <Plus className="size-3.5 shrink-0" />
        <div className="shrink-0 truncate text-sm font-normal text-foreground-muted">
          {translate('prompts.new')}
        </div>
      </div>
      <div className="min-w-0 truncate text-sm text-foreground">{draft.title}</div>
      {draft.prompt === draft.title ? null : (
        <div className="min-w-0 truncate text-xs text-foreground-passive">{draft.prompt}</div>
      )}
    </div>
  );
}
type AddContextPopoverSide = 'top' | 'bottom';

export function ActionItemBaseRow({
  icon,
  label,
  text,
}: {
  icon: React.ReactNode;
  label: string;
  text: string;
}) {
  return (
    <div className="flex h-5 w-full min-w-0 items-center gap-4">
      <div className="flex items-center gap-1.5">
        {icon}
        <div className="shrink-0 truncate text-sm font-normal text-foreground-muted">{label}</div>
      </div>
      <div className="truncate text-xs text-foreground-passive">{text}</div>
    </div>
  );
}

/**
 * 行内的编辑 / 删除。
 *
 * ⚠️ 这一格长在 `ComboboxItem` 里面,而那一整行的语义是「选中 = 把这条加进输入框」。所以按钮必须
 * 把事件**在冒泡到行之前**掐掉 —— 否则点「删除」的同时那条提示词也被塞进了输入框。
 * pointerdown 也要掐:Base UI 的 combobox 在 pointerdown 就开始处理选中,只拦 click 是拦不住的。
 */
function PromptRowActions({
  action,
  onEdit,
  onDelete,
}: {
  action: ContextAction & { kind: 'prompt' };
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { translate } = useSessionMessages();
  const swallow = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const run = (fn: () => void) => (event: React.MouseEvent) => {
    swallow(event);
    fn();
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/context-row:opacity-100 group-focus-within/context-row:opacity-100">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={translate('prompts.editLabel', { title: action.prompt.title })}
        onPointerDown={swallow}
        onClick={run(onEdit)}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={translate('prompts.deleteLabel', { title: action.prompt.title })}
        onPointerDown={swallow}
        onClick={run(onDelete)}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

export function ActionItemRow({
  action,
  onEditPrompt,
  onDeletePrompt,
}: {
  action: ContextAction;
  onEditPrompt?: (action: ContextAction & { kind: 'prompt' }) => void;
  onDeletePrompt?: (action: ContextAction & { kind: 'prompt' }) => void;
}) {
  switch (action.kind) {
    case 'linked-issue':
      return (
        <ActionItemBaseRow
          icon={<ProviderLogo provider={action.provider} className="h-3.5 w-3.5 shrink-0" />}
          label={action.issue.title}
          text={action.issue.identifier}
        />
      );
    case 'prompt':
      return (
        <div className="group/context-row flex w-full min-w-0 items-center gap-2">
          <ActionItemBaseRow
            icon={<TextInitial className="size-3.5 shrink-0" />}
            label={action.prompt.title}
            text={action.prompt.prompt}
          />
          {onEditPrompt && onDeletePrompt ? (
            <PromptRowActions
              action={action}
              onEdit={() => onEditPrompt(action)}
              onDelete={() => onDeletePrompt(action)}
            />
          ) : null}
        </div>
      );
    default:
      return null;
  }
}

export interface AddContextPopoverProps {
  actions: ContextAction[];
  disabled: boolean;
  /** 缺省 = 词表里那句「没有可加入的内容」。 */
  emptyMessage?: string;
  hideTrigger?: boolean;
  hotkeyEnabled?: boolean;
  isActivePane?: boolean;
  onApplyAction: (
    text: string,
    action: ContextAction,
    opts?: { andSend?: boolean }
  ) => Promise<void>;
  /** Replace the default "{translate('contextBar.addContext')}" button with a custom trigger. */
  renderTrigger?: (ctx: { open: boolean; disabled: boolean }) => ReactNode;
  side?: AddContextPopoverSide;
}

export function AddContextPopover({
  actions,
  disabled,
  emptyMessage,
  hideTrigger = false,
  hotkeyEnabled,
  isActivePane = true,
  onApplyAction,
  renderTrigger,
  side = 'top',
}: AddContextPopoverProps) {
  const { translate } = useSessionMessages();
  // 提示词的增删改就地做:这个弹层是用户唯一看得见提示词的地方,增删改却只长在「资源库」那一页上,
  // 而那一页在会话页没有可见入口 —— owner 2026-09-10:「找不到地方增删改,按理说如果在这里直接
  // 增删改也行啊」。写库仍是 usePromptLibraryActions 那一份,弹层不另存一套。
  const promptActions = usePromptLibraryActions();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<PopoverRow | null>(null);
  const [query, setQuery] = useState('');
  const ignoreOpenUntilRef = useRef(0);

  const filteredActions = useMemo(() => {
    if (!query) return actions;
    const q = query.toLowerCase();
    return actions.filter((action) => {
      switch (action.kind) {
        case 'linked-issue':
          return (
            action.issue.title.toLowerCase().includes(q) ||
            action.issue.identifier.toLowerCase().includes(q)
          );
        case 'prompt':
          return (
            action.prompt.title.toLowerCase().includes(q) ||
            action.prompt.prompt.toLowerCase().includes(q)
          );
      }
    });
  }, [query, actions]);

  // 打的字一条都没匹配上 → 列表位置改放「新建」这一行。空框时不放:没有内容,建不出东西,
  // 该显示的是空态里那句「怎么建」。
  const draft = useMemo(() => (filteredActions.length === 0 ? parsePromptDraft(query) : null), [
    filteredActions.length,
    query,
  ]);
  const rows = useMemo<PopoverRow[]>(
    () =>
      draft
        ? [{ kind: 'create-prompt' as const, id: `create-prompt:${draft.title}`, draft }]
        : filteredActions,
    [draft, filteredActions]
  );

  useEffect(() => {
    if (!isActivePane) return;

    commandRegistry.register({
      scopeId: 'session-sub',
      getCommands: () => [
        {
          id: ADD_CONTEXT_COMMAND.id,
          label: ADD_CONTEXT_COMMAND.label,
          description: ADD_CONTEXT_COMMAND.description,
          shortcutKey: ADD_CONTEXT_COMMAND.shortcutKey,
          group: ADD_CONTEXT_COMMAND.group,
          enabled: hotkeyEnabled ?? !disabled,
          execute: () => setOpen((value) => !value),
        },
      ],
    });

    return () => commandRegistry.unregister('session-sub');
  }, [disabled, hotkeyEnabled, isActivePane]);

  // 弹层与对话框是两层浮层:先收弹层再开对话框,❌ 让它们同时在场抢焦点(输入框还留在弹层里,
  // 对话框拿不到 autofocus)。
  const withPopoverClosed = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const handleConfirm = (row: PopoverRow | null, opts?: { andSend?: boolean }) => {
    if (!row) return;
    // 新建那一行:先落一条提示词,再照常把它的正文塞进输入框 —— 一次回车两件事都做完,
    // ❌ 不让用户建完再回来找一遍。
    const action: ContextAction = isCreateRow(row)
      ? { id: '', kind: 'prompt', prompt: promptActions.createPromptFromDraft(row.draft) }
      : row;
    const text = buildContextActionText(action);
    void onApplyAction(text, action, opts);
    setOpen(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && Date.now() < ignoreOpenUntilRef.current) {
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery('');
      // 高亮项也一起清:它只喂脚注那句提示,留着会让下次开弹层时脚注还挂着上一轮的
      // 「建立并加入输入框」,而列表里根本没有那一行。
      setSelected(null);
    }
  };

  const blockComboboxOpenForContextMenu = () => {
    ignoreOpenUntilRef.current = Date.now() + 500;
  };

  const blockSyntheticClickAfterContextMenu = (event: React.SyntheticEvent) => {
    if (Date.now() >= ignoreOpenUntilRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <Combobox
      items={[{ value: 'items', items: rows }]}
      // ⚠️ 关掉 Base UI 自带的那层过滤(`filter={null}`)。它默认还会按输入值把 `items` 再筛一遍,
      // 判据是把每项转成字符串 —— 我们的项是对象,没有字符串标签,于是**打上任何字都会被它筛空**,
      // 列表当场变「No context found」。筛选本来就由上面的 `filteredActions` 自己做,这一层是重复的;
      // 而且「打的字一条都匹配不上」正是要显示「新建」那一行的时刻,恰恰不能让它被筛掉。
      // (实机取证:未关之前,在搜索框里打字必然清空列表 —— owner 说的「这个添加上下文蛮奇怪的」就有它一份。)
      filter={null}
      value={null}
      onInputValueChange={(value) => setQuery(value ?? '')}
      inputValue={query}
      onValueChange={(row) => handleConfirm(row)}
      onItemHighlighted={(value) => setSelected(value ?? null)}
      open={open}
      onOpenChange={handleOpenChange}
      // 'always' highlights the first item on open; Base UI types narrow to boolean
      // but the runtime accepts the string literal
      autoHighlight={'always' as unknown as boolean}
    >
      <ComboboxTrigger
        disabled={disabled}
        onContextMenuCapture={() => blockComboboxOpenForContextMenu()}
        onPointerDownCapture={(event) => {
          if (event.button !== 0) blockComboboxOpenForContextMenu();
        }}
        onMouseDownCapture={(event) => {
          if (event.button !== 0) blockComboboxOpenForContextMenu();
        }}
        onClickCapture={(event) => {
          if (event.button !== 0) blockComboboxOpenForContextMenu();
          blockSyntheticClickAfterContextMenu(event);
        }}
        aria-hidden={hideTrigger || undefined}
        tabIndex={hideTrigger ? -1 : undefined}
        className={cn(
          hideTrigger
            ? 'pointer-events-none absolute bottom-0 left-1/2 size-px -translate-x-1/2 overflow-hidden border-0 p-0 opacity-0'
            : renderTrigger
              ? undefined
              : // ❌ 曾经这里有 border-border:只写了颜色没写宽度,是一条永不渲染的死类
                // (line budget —— 2026-09-22 删掉,分组感已经靠 bg-background-secondary-2 表达)。
                'flex h-6 min-w-[160px] items-center justify-between gap-1.5 rounded-lg bg-background-secondary-2 px-2 text-xs font-normal text-foreground-muted transition-colors hover:bg-row-hover hover:text-foreground disabled:pointer-events-none'
        )}
      >
        {hideTrigger ? null : renderTrigger ? (
          renderTrigger({ open, disabled })
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              {open ? (
                <ChevronUp className="size-3 shrink-0" />
              ) : (
                <ChevronDown className="size-3 shrink-0" />
              )}
              <span>{translate('contextBar.addContext')}</span>
            </span>
            <BoundShortcut settingsKey="addContext" variant="keycaps" />
          </>
        )}
      </ComboboxTrigger>

      <ComboboxContent
        side={side}
        align="center"
        className="flex min-h-[200px] max-w-[92vw] min-w-[440px] flex-col"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            handleConfirm(selected ?? rows[0] ?? null, { andSend: true });
          }
        }}
      >
        <ComboboxInput showTrigger={false} placeholder={translate('contextBar.searchPlaceholder')} />
        <ComboboxList className="flex-1">
          {(group: { value: string; items: PopoverRow[] }) => (
            <ComboboxGroup items={group.items}>
              <ComboboxCollection>
                {(row: PopoverRow) => (
                  <ComboboxItem key={row.id} value={row} className="items-start">
                    {isCreateRow(row) ? (
                      <CreatePromptRowView draft={row.draft} />
                    ) : (
                      <ActionItemRow
                        action={row}
                        onEditPrompt={(prompt) =>
                          withPopoverClosed(() => promptActions.editPrompt(prompt.prompt))
                        }
                        onDeletePrompt={(prompt) =>
                          withPopoverClosed(() => promptActions.deletePrompt(prompt.prompt))
                        }
                      />
                    )}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        {/* 空态只在「框是空的、也确实没东西可列」时出现 —— 打了字却没匹配上时,列表位置放的是
            上面那行「新建」,不是空态。所以这句话该教的是怎么建,不是「什么都没有」。 */}
        <ComboboxEmpty className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          <span className="text-sm text-foreground-muted">
            {emptyMessage ?? translate('contextBar.empty')}
          </span>
          <span className="text-xs text-foreground-passive">
            {translate('contextBar.createHint')}
          </span>
        </ComboboxEmpty>
        <div className="flex items-center justify-end border-t px-2 py-1.5">
          <span className="flex items-center gap-1">
            <p className="text-xs text-foreground-passive">
              {translate(isCreateRow(selected) ? 'contextBar.createAndAdd' : 'contextBar.addToInput')}
            </p>
            <Shortcut hotkey="Enter" variant="keycaps" />
          </span>
        </div>
      </ComboboxContent>
    </Combobox>
  );
}

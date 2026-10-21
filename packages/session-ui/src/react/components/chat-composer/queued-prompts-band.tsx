import { Button } from '@session-ui/react/primitives/button';
import { DropdownMenu } from '@session-ui/react/primitives/dropdown-menu';
import { cx } from '@session-ui/styles/utilities/cx';
import { ArrowRight, Ellipsis, ListTree, Pencil, X } from '../../../icons'
import { GripVertical } from 'lucide-react'
import * as React from 'react';
import * as styles from './queued-prompts-band.css';
import { useMessages } from '../../localization/message-provider';

export type ComposerQueuedPrompt = {
  id: string;
  text: string;
  origin: 'manual' | 'typed';
  /** 「立即发送」会插进当前回合(这家能插话),而不是取消它再发 —— 只换按钮提示(#6574)。 */
  sendNowSteers?: boolean;
  /**
   * 会话还没连上时排进去的那一句:运行时还没给它在队列里的编号,改、删、挪、立即发送都做不到 ⇒ 只显示、不给操作;
   * 会话一连上就换成能操作的那一份。❌ 摆着按钮、点了才报「没连上」。
   */
  locked?: boolean;
};

export interface QueuedPromptsBandProps {
  prompts: ComposerQueuedPrompt[];
  /**
   * 排队中的那条**显示**成什么。缺席就按原文显示。
   *
   * 排队条打印的是「将要发出去的原文」,而 @ 提及在原文里是它的地址(`@user:<uuid>`)——
   * 输入框里和聊天记录里它都是一枚写着名字的 pill,唯独这里把地址摆到了用户脸上
   * (owner 2026-09-16 实撞)。宿主知道 token → 名字的账,所以由宿主给这一格的显示形态。
   * ⚠️ 只管**显示**:点进去编辑的仍是原文,那是真要发出去的东西,❌ 不能拿显示形态骗人。
   */
  renderPromptText?: (text: string) => React.ReactNode;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onSendNow: (id: string) => void;
  editingId?: string | null;
  className?: string;
}

export function QueuedPromptsBand({
  prompts,
  renderPromptText,
  onEdit,
  onDelete,
  onReorder,
  onSendNow,
  editingId,
  className,
}: QueuedPromptsBandProps) {
  const { translate } = useMessages();
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dragOverId, setDragOverId] = React.useState<string | null>(null);
  const ids = prompts.filter((prompt) => !prompt.locked).map((prompt) => prompt.id);

  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const index = ids.indexOf(fromId);
    const nextIndex = ids.indexOf(toId);
    if (index < 0 || nextIndex < 0) return;
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(nextIndex, 0, moved);
    onReorder(next);
  };

  const handleDragStart = (event: React.DragEvent<HTMLButtonElement>, id: string) => {
    setDraggingId(id);
    setDragOverId(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    if (!draggingId || !ids.includes(id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverId(id);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData('text/plain') || draggingId;
    if (draggedId) reorder(draggedId, id);
    setDraggingId(null);
    setDragOverId(null);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverId(null);
  };

  if (prompts.length === 0) return null;

  return (
    <div
      data-slot="composer-queued-prompts"
      role="region"
      aria-label={`${translate('composer.queuedPrompts')} (${prompts.length})`}
      className={cx(styles.band, className)}
    >
      <div className={styles.list} role="list">
        {prompts.map((prompt, index) => {
          const isEditing = editingId === prompt.id;
          return (
            <div
              key={prompt.id}
              role="listitem"
              data-queued-prompt-id={prompt.id}
              className={styles.row}
              data-editing={isEditing || undefined}
              data-dragging={draggingId === prompt.id || undefined}
              data-drag-over={dragOverId === prompt.id || undefined}
              onDragOver={(event) => handleDragOver(event, prompt.id)}
              onDragLeave={() =>
                setDragOverId((current) => (current === prompt.id ? null : current))
              }
              onDrop={(event) => handleDrop(event, prompt.id)}
            >
              <span className={styles.leadingSlot}>
                <ListTree className={styles.queueIcon} aria-hidden />
                {!isEditing && !prompt.locked && ids.length > 1 && (
                  <button
                    type="button"
                    className={styles.dragHandle}
                    draggable
                    aria-label={translate('composer.reorderQueuedPrompt', { index: index + 1 })}
                    title={translate('composer.dragToReorder')}
                    onClick={(event) => event.stopPropagation()}
                    onDragStart={(event) => handleDragStart(event, prompt.id)}
                    onDragEnd={handleDragEnd}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                      event.preventDefault();
                      const target = ids[ids.indexOf(prompt.id) + (event.key === 'ArrowUp' ? -1 : 1)];
                      if (target) reorder(prompt.id, target);
                    }}
                  >
                    <GripVertical className={styles.dragHandleIcon} aria-hidden />
                  </button>
                )}
              </span>

              {prompt.locked ? (
                <span className={cx(styles.promptText, !prompt.text.trim() && styles.emptyText)} data-locked="true">
                  {prompt.text.trim() ? renderPromptText?.(prompt.text) ?? prompt.text.trim() : translate('composer.imageOnlyPrompt')}
                </span>
              ) : (
                <button
                  type="button"
                  className={cx(styles.promptText, !prompt.text.trim() && styles.emptyText)}
                  onClick={() => onEdit(prompt.id, prompt.text)}
                  disabled={!!editingId}
                  aria-label={translate('composer.editQueuedPrompt', { index: index + 1 })}
                  title={translate('composer.editQueuedPrompt', { index: index + 1 })}
                >
                  {prompt.text.trim()
                    ? renderPromptText?.(prompt.text) ?? prompt.text.trim()
                    : translate('composer.imageOnlyPrompt')}
                </button>
              )}

              {!isEditing && !prompt.locked && (
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.sendNow}
                    aria-label={translate(prompt.sendNowSteers ? 'composer.steerQueuedPromptNow' : 'composer.sendQueuedPromptNow', { index: index + 1 })}
                    title={translate(prompt.sendNowSteers ? 'composer.sendNowSteersTurn' : 'composer.sendNowCancelsTurn')}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSendNow(prompt.id);
                    }}
                  >
                    <ArrowRight className={styles.actionIcon} />
                    {translate(prompt.sendNowSteers ? 'composer.steerQueuedPrompt' : 'composer.sendQueuedPrompt')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon
                    aria-label={translate('composer.deleteQueuedPrompt')}
                    title={translate('composer.deleteQueuedPrompt')}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(prompt.id);
                    }}
                  >
                    <X className={styles.actionIcon} />
                  </Button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger
                      render={<Button type="button" variant="ghost" size="sm" icon />}
                      aria-label={translate('composer.queuedPromptActions', { index: index + 1 })}
                      title={translate('composer.queuedPromptActions', { index: index + 1 })}
                      disabled={!!editingId}
                    >
                      <Ellipsis className={styles.actionIcon} />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end" side="top" width="content">
                      <DropdownMenu.Item onClick={() => onEdit(prompt.id, prompt.text)}>
                        <Pencil className={styles.actionIcon} />
                        {translate('composer.editQueuedPrompt', { index: index + 1 })}
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

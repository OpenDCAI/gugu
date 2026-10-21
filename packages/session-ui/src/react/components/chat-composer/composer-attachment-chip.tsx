import { LoadingIndicator } from '../loading-indicator/LoadingIndicator';
/**
 * ComposerAttachmentChip —— 输入框附件条上的一枚 chip。
 *
 * 解剖照 assistant-ui `elements-composer` 的 `ComposerAttachmentChip` 逐值转写(#5269,
 * 上游源 r.assistant-ui.com/elements-composer.json):
 *
 *   <div data-slot="composer-attachment" data-state="uploading | done | error">
 *     <icon cell 32px>      image / text / archive 线图;图片型用缩略图填格
 *     <name 12px/500 · meta 11px>   meta = 大小 / 百分比 / 错误原因,error 时变红
 *     <trailing 20px>       uploading 转圈 · done 有 onRemove 显 × 没有显 ✓ · error 见下
 *     <progress 2px>        只在 uploading 且宿主给了 progress 时挂在底边
 *   </div>
 *
 * 与上游的**两处**有意偏差:
 * ① 上游 error 态尾槽空着(只把 meta 变红),失败的附件没法从条上清掉;我们 error 态照样给 ×。
 * ② **整块 chip 是预览的触发器**(有可看的内容时)。上游这一份是纯 div、点不开,它的 runtime
 *    车道 `attachment.aui.tsx` 才有预览,做法正是把整块 tile 套进 DialogTrigger、`role="button"`
 *    + Enter/Space + `active:scale(0.96)` —— 我们照那一份的交互，摆在这一份的形状上。
 *    ⚠️ 从前只有 32px 图标格是按钮:目标 32×32、且只对图片开,owner 2026-09-09 在新建会话页
 *    点了半天没反应。可点的面积必须是**整枚 chip**。
 *
 * 其余几何一个不改,颜色换成本仓 token(见 chat-composer.css.ts)。
 */
import { Archive, Check, FileImage, FileText, Folder, X } from '../../../icons';
import { useMessages } from '../../localization/message-provider';
import { attachmentPreviewKind } from './composer-attachment-preview';
import type { ComposerAttachment, ComposerAttachmentState } from './composer-options';
import * as styles from './chat-composer.css';

const archiveFileExtension = /\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar|dmg|iso)$/i;

/** 上游按 kind 选 image / text / archive 三种线图;我们的 kind 只有 image | file,archive 按扩展名认。 */
function attachmentKindIcon(att: ComposerAttachment) {
  if (att.kind === 'image') return FileImage;
  // 传到别的机器上的文件夹(#6264):整个文件夹是一件附件。
  if (att.mimeType === 'inode/directory') return Folder;
  if (archiveFileExtension.test(att.name)) return Archive;
  return FileText;
}

export interface ComposerAttachmentChipProps {
  attachment: ComposerAttachment;
  /**
   * 点开预览。宿主接了它,**并且**这枚 chip 手上有可看的内容(`attachmentPreviewKind`)时,
   * 整块 chip 才变成触发器;两者缺一就渲染成不可点的静态 chip。
   */
  onView?: (att: ComposerAttachment) => void;
  /** 给了才有 ×;不给的 done 态显 ✓(上游语义:没人在听移除,就没有可移除的东西)。 */
  onRemove?: (id: string) => void;
  /** 给了、且这枚 chip `retryable`,error 态的 meta 后面跟一段「重试」强调色文字。 */
  onRetry?: (id: string) => void;
}

export function ComposerAttachmentChip({ attachment: att, onView, onRemove, onRetry }: ComposerAttachmentChipProps) {
  const { translate } = useMessages();
  const state: ComposerAttachmentState = att.state ?? 'done';
  const KindIcon = attachmentKindIcon(att);
  const previewKind = onView ? attachmentPreviewKind(att) : null;
  const cell =
    att.kind === 'image' && att.previewUrl ? (
      <img src={att.previewUrl} alt={att.name} className={styles.attachmentThumbImg} />
    ) : (
      <KindIcon aria-hidden="true" className={styles.attachmentIcon} />
    );
  // 传输中也能 × 掉(= 取消),前提是宿主说这次传输取消得了;进度由底边那条进度条表达,尾槽让给 ×。
  const canRemove = !!onRemove && (state !== 'uploading' || att.cancelable === true);
  const canRetry = state === 'error' && att.retryable === true && !!onRetry;

  return (
    <div
      data-slot="composer-attachment"
      data-state={state}
      data-viewable={previewKind ?? undefined}
      role={previewKind ? 'button' : undefined}
      tabIndex={previewKind ? 0 : undefined}
      aria-label={previewKind ? translate('composer.viewAttachment', { name: att.name }) : undefined}
      onClick={previewKind ? () => onView?.(att) : undefined}
      // 键盘照上游:Enter 立刻触发,Space 按下时吃掉默认滚动、抬起时才触发。
      onKeyDown={
        previewKind
          ? (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onView?.(att);
              } else if (event.key === ' ') {
                event.preventDefault();
              }
            }
          : undefined
      }
      onKeyUp={previewKind ? (event) => { if (event.key === ' ') onView?.(att); } : undefined}
      className={styles.attachmentChip}
    >
      <span className={styles.attachmentIconCell}>{cell}</span>
      <span className={styles.attachmentLabel}>
        <span className={styles.attachmentName}>{att.name}</span>
        {(att.meta || canRetry) && (
          <span className={styles.attachmentMeta({ error: state === 'error' })} title={state === 'error' ? att.meta : undefined}>
            {att.meta}
            {canRetry && (
              <>
                {att.meta ? ' · ' : null}
                <button
                  type="button"
                  className={styles.attachmentRetry}
                  // 同 × :整块 chip 可能是预览触发器,别让重试顺手把预览打开。
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetry?.(att.id);
                  }}
                >
                  {translate('composer.retryAttachment')}
                </button>
              </>
            )}
          </span>
        )}
      </span>
      <span className={styles.attachmentTrailing}>
        {state === 'uploading' && !canRemove ? (
          <LoadingIndicator size="inline" />
        ) : canRemove ? (
          <button
            type="button"
            aria-label={translate(state === 'uploading' ? 'composer.cancelAttachment' : 'composer.removeAttachment', { name: att.name })}
            // ⚠️ 整块 chip 现在是触发器 —— 不拦住冒泡的话,点 × 会在删掉它的同一下把预览开出来。
            onClick={(event) => {
              event.stopPropagation();
              onRemove?.(att.id);
            }}
            className={styles.attachmentRemove}
          >
            <X className={styles.attachmentRemoveIcon} />
          </button>
        ) : state === 'done' ? (
          <Check aria-hidden="true" className={styles.attachmentCheck} />
        ) : null}
      </span>
      {state === 'uploading' && typeof att.progress === 'number' && (
        <span
          aria-hidden="true"
          className={styles.attachmentProgress}
          style={{ width: `${Math.min(100, Math.max(0, att.progress))}%` }}
        />
      )}
    </div>
  );
}

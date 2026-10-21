import { ScrollContainer } from '@session-ui/react/primitives/scroll-container';
import { Dialog } from '@session-ui/react/primitives/dialog';
import { useMessages } from '../../localization/message-provider';
import * as styles from './attachment-viewer-dialog.css';

/**
 * 点开一枚附件看里面是什么(#5269)。
 *
 * 一个对话框认两种内容,而不是两个对话框:用户点的是「这个附件」,看到的东西是图还是字
 * 由附件自己决定 —— 让宿主先分类再挑对话框,分类逻辑就会在每个宿主那儿各长一份。
 * 图片来自 `src`(data:/blob: URL),文本来自 `text`(宿主入列时读进来的,见
 * `readAttachmentPreviewText`);两个都没有时对话框如实说「没有可预览的内容」,
 * ❌ 不装作在加载。
 */
export interface AttachmentViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 图片的 data/blob URL;非图片附件不给。 */
  src?: string;
  /** 文本附件的内容。 */
  text?: string;
  /** `text` 只是文件的前一段时为真,挂一行说明。 */
  truncated?: boolean;
  /** 附件名,做标题。 */
  name?: string;
}

export function AttachmentViewerDialog({
  open,
  onOpenChange,
  src,
  text,
  truncated,
  name,
}: AttachmentViewerDialogProps) {
  const { translate } = useMessages();
  const title = name ?? translate('attachmentViewer.title');
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {/* 尺寸跟着内容走,❌ 不用 `xl` —— 那一档写死 `height: 80vh`,一段几行的文本会被撑成一个
          空荡荡的大盒子(2026-09-09 真机截图)。上游 assistant-ui 的预览弹层同样是内容定高
          (`sm:max-w-3xl` + `max-h-[80dvh]`)。 */}
      <Dialog.Content size="lg">
        <Dialog.Header>
          <Dialog.Title>{title}</Dialog.Title>
        </Dialog.Header>
        {src ? (
          <div className={styles.imageContainer}>
            <img src={src} alt={title} className={styles.image} />
          </div>
        ) : typeof text === 'string' ? (
          <div className={styles.textContainer}>
            {/* ⚠️ 高度必须走 `maxHeight` 这个 prop:它落在**内层滚动视口**上,写在 className 里
                只会约束外壳,视口照样长出去 —— 真机上表现为文字顶穿弹层底边(2026-09-09)。 */}
            <ScrollContainer maxHeight="60vh" className={styles.textScroll}>
              <pre className={styles.text}>{text}</pre>
            </ScrollContainer>
            {truncated && (
              <p className={styles.truncatedNote}>{translate('attachmentViewer.truncated')}</p>
            )}
          </div>
        ) : (
          <div className={styles.imageContainer}>
            <p className={styles.unavailable}>{translate('attachmentViewer.unavailable')}</p>
          </div>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

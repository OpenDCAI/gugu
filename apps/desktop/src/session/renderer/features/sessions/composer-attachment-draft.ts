import type { ComposerAttachment } from '@gugu/session-ui/react/components';

/** 创建页切换的待发附件:chip 只握着原始文件,建好任务之后才放(P3),换目标不带走任何已放好的东西。 */
export type ComposerAttachmentDraft = {
  pending: Array<{ chip: ComposerAttachment; file: File }>;
};

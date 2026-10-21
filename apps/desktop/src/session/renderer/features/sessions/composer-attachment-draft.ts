import type { ComposerAttachment } from '@gugu/session-ui/react/components';
import type { UploadSource } from './acp/composer-file-upload';

/** 创建页切换的待发附件:保留原始字节,新目标重新上传,不复用旧机器的路径。 */
export type ComposerAttachmentDraft = {
  uploads: Array<{ chip: ComposerAttachment; source: UploadSource }>;
  pending: Array<{ chip: ComposerAttachment; file: File }>;
};

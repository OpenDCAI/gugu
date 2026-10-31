// 新建框(新建会话页、项目页)写了一半的首句,按创建目标暂存在渲染进程内存:
// 页面卸载(切去某条会话、换机器整棵重挂)再回来还在;发送成功即清;不落盘。
// 已开会话的草稿不在这里 —— 那一份跟着会话走(AcpChatStore → runtime 会话格)。
import type { ComposerAttachmentDraft } from './composer-attachment-draft';

const drafts = new Map<string, string>();
const attachments = new Map<string, ComposerAttachmentDraft>();
const captureAttachments = new Map<string, () => ComposerAttachmentDraft>();

/** 新建会话页(home / new-task 两个视图、手机全屏新建)共用一格:换机器、换项目都带着走。 */
export const NEW_SESSION_DRAFT_KEY = 'new-session';

export function projectDraftKey(projectId: string): string {
  return `project:${projectId}`;
}

export const composerDrafts = {
  attachments: (key: string): ComposerAttachmentDraft | undefined => attachments.get(key),
  consumeAttachments(key: string): void { attachments.delete(key); },
  registerAttachments(key: string, capture: () => ComposerAttachmentDraft): () => void {
    captureAttachments.set(key, capture);
    return () => { if (captureAttachments.get(key) === capture) captureAttachments.delete(key); };
  },
  get: (key: string): string => drafts.get(key) ?? '',
  set(key: string, text: string): void {
    if (text.trim()) drafts.set(key, text);
    else drafts.delete(key);
  },
  /** 显式换创建目标:空目标接走首句,不留下会在切回来时盖住新编辑的旧副本。 */
  moveToEmpty(from: string, to: string): void {
    if (from === to) return;
    const capture = captureAttachments.get(from);
    if (capture) {
      const snapshot = capture();
      if (snapshot.pending.length) attachments.set(from, snapshot);
      else attachments.delete(from);
    }
    const text = drafts.get(from);
    if (drafts.has(to) || attachments.has(to)) return;
    if (text) drafts.set(to, text);
    const snapshot = attachments.get(from);
    if (snapshot) attachments.set(to, snapshot);
    drafts.delete(from);
    attachments.delete(from);
  },
};

// 新建框(新建会话页、项目页)写了一半的首句,按创建目标暂存在渲染进程内存:
// 页面卸载(切去某条会话、换机器整棵重挂)再回来还在;提交时交给请求,失败归还;不落盘。
// 已开会话的草稿不在这里 —— 那一份跟着会话走(AcpChatStore → runtime 会话格)。
import type { ComposerAttachmentDraft } from './composer-attachment-draft';
import { action, makeAutoObservable, observable } from 'mobx';
import type { TurnFileRef } from '@gugu/session-core/session-record/contract';
import type { SessionFailure } from './stores/session-failure';

export interface PendingCreationMessage {
  projectId: string;
  sessionId: string;
  clientMessageId: string;
  prompt: string;
  text: string;
  files?: TurnFileRef[];
}

export type SubmittedComposerDraft = ComposerAttachmentDraft & { prompt: string };

/** The unsubmitted input and the existing creation lifecycle follow the draft, not its page. */
export class ComposerDraft {
  prompt = '';
  pending: ComposerAttachmentDraft['pending'] = [];
  creating = false;
  pendingMessage: PendingCreationMessage | null = null;
  deliveryError: SessionFailure | null = null;

  constructor() {
    makeAutoObservable(this, {
      pending: observable.ref,
      pendingMessage: observable.ref,
      deliveryError: observable.ref,
    }, { autoBind: true });
  }

  get attachments() { return this.pending.map(({ chip }) => chip); }

  setPrompt(text: string): void {
    const next = text.trim() ? text : '';
    if (next === this.prompt) return;
    this.prompt = next;
    this.deliveryError = null;
    this.clearEmptyRetry();
  }
  setPending(pending: ComposerAttachmentDraft['pending']): void {
    this.pending = pending;
    this.deliveryError = null;
    this.clearEmptyRetry();
  }
  setCreating(creating: boolean): void { this.creating = creating; }
  setPendingMessage(message: PendingCreationMessage | null): void { this.pendingMessage = message; }
  setDeliveryError(error: SessionFailure | null): void { this.deliveryError = error; }

  private clearEmptyRetry(): void {
    if (!this.creating && !this.prompt && !this.pending.length) this.pendingMessage = null;
  }

  take(): SubmittedComposerDraft {
    const submitted = { prompt: this.prompt, pending: this.pending };
    this.prompt = '';
    this.pending = [];
    return submitted;
  }

  restore(submitted: SubmittedComposerDraft, withFiles: boolean): void {
    this.prompt = [submitted.prompt, this.prompt].filter(Boolean).join('\n');
    if (withFiles) this.pending = [...submitted.pending, ...this.pending];
  }
}

const drafts = observable.map<string, ComposerDraft>({}, { deep: false });

/** 新建会话页(home / new-task 两个视图、手机全屏新建)共用一格:换机器、换项目都带着走。 */
export const NEW_SESSION_DRAFT_KEY = 'new-session';

export function projectDraftKey(projectId: string): string {
  return `project:${projectId}`;
}

const forKey = action((key: string): ComposerDraft => {
  let draft = drafts.get(key);
  if (!draft) { draft = new ComposerDraft(); drafts.set(key, draft); }
  return draft;
});

export const composerDrafts = {
  forKey,
  has: (draft: ComposerDraft): boolean => [...drafts.values()].includes(draft),
  discard: action((key: string): void => {
    const draft = drafts.get(key);
    if (!draft) return;
    const discarded = draft.take();
    for (const { chip } of discarded.pending) {
      if (chip.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(chip.previewUrl);
    }
    draft.setPendingMessage(null);
    draft.setDeliveryError(null);
    drafts.delete(key);
  }),
  get: (key: string): string => drafts.get(key)?.prompt ?? '',
  set(key: string, text: string): void { forKey(key).setPrompt(text); },
  /** Move the object itself: a running request keeps the same lock, retry and error destination. */
  moveToEmpty: action((from: string, to: string): void => {
    if (from === to) return;
    const source = drafts.get(from);
    const destination = drafts.get(to);
    if (!source || destination && (destination.prompt || destination.pending.length || destination.creating || destination.pendingMessage)) return;
    drafts.set(to, source);
    drafts.delete(from);
  }),
};

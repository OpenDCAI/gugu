export interface SessionpageAgentAddress {
  chatId: string;
  agentUserId: string;
}

/** 一件待发附件:composer 给的稳定 id + 用户选中的原始 File。 */
export interface SessionpageAttachmentFile {
  id: string;
  file: File;
}

export interface SessionpageMessageHost {
  sendMessageToChat(
    chatId: string,
    text: string,
    options: { toUserIds: string[]; clientMessageId: string },
  ): Promise<string | undefined>;
  /**
   * 附件走消息面**既有的**那条批发送路径(upload chat-media → `content_type='attachment'` 消息 →
   * 标准投递),与用户稍后在同一 DM 里再发一个文件调用的是同一份实现(#4325)。
   *
   * 逐件回报:一件真的落库并读回验证通过了才 `onSent(id)`,composer 据此只移走已提交的那一件——
   * 失败时剩下的仍留在 composer 里等显式重试,❌ 不静默丢。
   */
  sendAttachmentsToChat(
    chatId: string,
    files: SessionpageAttachmentFile[],
    options: { toUserIds: string[]; onSent: (id: string) => void },
  ): Promise<void>;
  openAgentChat(address: SessionpageAgentAddress): void;
}

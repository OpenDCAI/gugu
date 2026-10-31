/**
 * 有会话正在工作所以没切订阅。界面要按自己的语言、用平和的口吻写这句话,所以哪一家、几个会话
 * 跟着错误一起走;`message` 是旧界面与日志看的英文原话。
 */
export class SubscriptionSessionsBusyError extends Error {
  constructor(
    readonly providerId: 'claude' | 'codex',
    readonly count: number
  ) {
    const label = providerId === 'claude' ? 'Claude' : 'Codex';
    super(
      `${count} ${label} session${count === 1 ? ' is' : 's are'} still working. ` +
        `Switch the subscription after they finish; switching restarts every running ${label} session.`
    );
    this.name = 'SubscriptionSessionsBusyError';
  }
}

export type ConnectionFailure = {
  type: 'invalid-state';
  message: string;
  sessionsBusy?: { providerId: string; count: number };
};

/** 连接操作失败在线上的样子:`sessionsBusy` 是可选字段,不认识它的旧界面照 `message` 显示。 */
export function connectionFailure(error: unknown): ConnectionFailure {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof SubscriptionSessionsBusyError
    ? { type: 'invalid-state', message, sessionsBusy: { providerId: error.providerId, count: error.count } }
    : { type: 'invalid-state', message };
}

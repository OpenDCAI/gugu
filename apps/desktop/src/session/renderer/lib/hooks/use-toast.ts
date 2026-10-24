import { dismissNotice, notify, type Notice } from '../../../../lib/notices';

// 会话页的提示出口。实现在 lib/notices(全 app 一份,#137);这里只保留会话页一直在用的名字。
type Toast = Notice;

const toast = notify;

function useToast() {
  return { toast };
}

export { dismissNotice, toast, useToast };
export type { Toast };

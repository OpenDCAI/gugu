export { formatSessionTitleForDisplay } from '@shared/core/sessions/session-title-utils';
// 两条纯规则搬去了 shared(主进程为手机端建会话时要同一个算法);这里只保旧 import 路径。
export {
  sessionTitleFromPrompt,
  nextDefaultSessionTitle,
} from '@shared/core/sessions/session-title';

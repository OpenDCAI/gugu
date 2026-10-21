import type {
  SessionHistoryDirectoryParams,
  SessionHistoryParams,
} from '@shared/core/session-history/session-history';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { listSessionHistory, listSessionHistoryDirectories } from './list-session-history';

/**
 * spec session-page「会话历史」(#6083)。两种读法:`listDirectories` 是默认的目录视图(一目录一行),
 * `list` 是平铺的会话表(也是展开一个目录时取它里面会话的那条路)。行动作不在这里:打开走既有的
 * 会话打开路径,恢复走 `conversations.restoreSession`,导入走 `sessionImport.importLocalSession`
 * —— 面板只是把三种会话摆到一张表里,不另造一套动词。
 */
export const sessionHistoryController = createRPCController({
  list: (params: SessionHistoryParams) => listSessionHistory(params),
  listDirectories: (params: SessionHistoryDirectoryParams) => listSessionHistoryDirectories(params),
});

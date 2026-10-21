import type {
  ImportLocalSessionParams,
  ListLocalSessionsParams,
  PreviewLocalSessionParams,
} from '@shared/core/session-import/session-import';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { hasLocalSessionSource, getLocalSessionSource } from './host-source';
import { importLocalSession } from './import-local-session';

export const sessionImportController = createRPCController({
  /** 本机能不能导入会话（web / 未接线的宿主上为 false，入口据此隐藏而不是点了才报错）。 */
  isAvailable: () => Promise.resolve(hasLocalSessionSource()),
  listLocalSessions: (params: ListLocalSessionsParams) => getLocalSessionSource().list(params),
  previewLocalSession: (params: PreviewLocalSessionParams) =>
    getLocalSessionSource().preview(params),
  importLocalSession: (params: ImportLocalSessionParams) => importLocalSession(params),
});

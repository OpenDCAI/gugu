// #7199 助理搬家时账号类授权在两台机器之间走的形状(主进程 integrations.exportForMove / importFromMove 与渲染层编排共用)。
// 凭据只在主人自己两台设备之间经现有的设备通道走,❌ 落到服务器上存。
import type { IntegrationCredentials } from '@gugu/session-plugins/integrations';

export type MovableIntegrationAccount = {
  integrationId: string;
  accountId: string;
  displayName?: string;
  isDefault: boolean;
  credentials: IntegrationCredentials;
};

export type MoveSkipReason =
  /** 走官方命令行的集成:登录态在那台机器的命令行目录里,带不走,新家要重新连。 */
  | 'cli'
  /** 有这条记录、本机却没有可读的密钥(gh 命令行代管的账号、密钥库读不出来)。 */
  | 'no-secret'
  /** 新家这一版咕咕不认这一家集成(导入时才会出现)。 */
  | 'unknown-integration'
  /** 新家已经连着同名(同一家、同一个账号 id)却不是同一份凭据的账号:不覆盖,旧家那份也不撤(导入时才会出现)。 */
  | 'exists';

export type MoveSkipped = { integrationId: string; accountId?: string; reason: MoveSkipReason };

export type IntegrationMoveExport = {
  accounts: MovableIntegrationAccount[];
  skipped: MoveSkipped[];
};

export type IntegrationMoveImport = {
  imported: number;
  skipped: MoveSkipped[];
};

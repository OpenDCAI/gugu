import { integrationPluginRegistry, type IntegrationCredentials } from '@gugu/session-plugins/integrations';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { cliMethodOf } from './cli/cli-integrations';
import { checkAllIntegrationConnections, checkConfiguredIntegrations } from './connection-statuses';
import { integrationConnectionService } from './integration-connection-service';
import { integrationCredentialStore } from './integration-credential-store-instance';
import {
  exportAccountsForMove,
  importAccountsFromMove,
  previewAccountsForMove,
  type IntegrationMoveDeps,
  type MovableIntegrationAccount,
} from './integration-move';
import { buildIntegrationListPayload } from './integration-payload-builder';

const moveDeps: IntegrationMoveDeps = {
  integrationIds: () => integrationPluginRegistry.getAll().map((plugin) => plugin.metadata.id),
  isCli: (integrationId) => cliMethodOf(integrationId) !== null,
  hasIntegration: (integrationId) => integrationPluginRegistry.get(integrationId) !== undefined,
  listAccounts: (integrationId) => integrationCredentialStore.listAccountsDetailed(integrationId),
  upsertAccount: (integrationId, account) => integrationCredentialStore.upsertAccount(integrationId, account),
  setDefault: (integrationId, accountId) => integrationCredentialStore.setDefault(integrationId, accountId),
};

export const integrationsController = createRPCController({
  /** `locale` = 请求方的界面语言(插件的中英两份在这里解析成字符串);老桌面不传 ⇒ en。 */
  list: async (locale?: string) => buildIntegrationListPayload(locale),

  /** 资源库那一页:注册表里每一家连没连上(检查一次)/ 存没存着凭据(不联网)。 */
  checkAllConnections: async () => checkAllIntegrationConnections(),

  checkConfiguredConnections: async () => checkConfiguredIntegrations(),

  /** `editAccountId`(#7240「编辑凭据」):改的是哪个已存账号,留空的授权码沿用存着的。老桌面不传。 */
  connect: async (integrationId: string, credentials: IntegrationCredentials, editAccountId?: string) =>
    integrationConnectionService.connect(integrationId, credentials, editAccountId),

  /** `accountId`(#7240):多账号里只断开这一个;不传 = 整家断开(老桌面)。 */
  disconnect: async (integrationId: string, accountId?: string) =>
    integrationConnectionService.disconnect(integrationId, accountId),

  /** #7240 这一家存着的每个账号(不含任何保密项)。 */
  accounts: async (integrationId: string) => integrationConnectionService.listAccounts(integrationId),

  /** #7240 每个账号各查一次还连不连得上。 */
  checkAccounts: async (integrationId: string) => integrationConnectionService.checkAccounts(integrationId),

  authorize: async (integrationId: string) => integrationConnectionService.authorize(integrationId),

  /**
   * #6264 连别的机器上的集成:浏览器授权在这台桌面上做(回调只能落在本机的 127.0.0.1),
   * 凭据不在这里存,交回去给那台机器的 `connect`。
   */
  acquireAuthorization: async (integrationId: string) =>
    integrationConnectionService.acquireAuthorization(integrationId),

  cancelAuthorization: async (integrationId: string) =>
    integrationConnectionService.cancelAuthorization(integrationId),

  /**
   * #7210 官方命令行(钉钉 dws、企业微信 wecom-cli):在**这台**机器上装好工具、起它自带的登录,回给人看的
   * 授权链接 / 二维码;之后 `cliLoginWait` 一问一答等它登上(每问最多 20 秒)。远程机器上也是那台机器自己跑。
   */
  cliLoginStart: async (integrationId: string) => integrationConnectionService.cliLoginStart(integrationId),
  /** 起登录前先装好工具:一问最多 20 秒,装得慢(远程机器上十来分钟)也不绑在一次调用上。 */
  cliToolPrepare: async (integrationId: string) => integrationConnectionService.cliToolPrepare(integrationId),

  cliLoginWait: async (integrationId: string) => integrationConnectionService.cliLoginWait(integrationId),
  cliLoginProgress: async (integrationId: string) => integrationConnectionService.cliLoginProgress(integrationId),

  /**
   * #7199 助理搬家:这台机器上连着的账号类集成,连凭据一起交出去(只在「同一个主人的两台机器」之间走,
   * 与别的 integrations 方法同一道门)。命令行那几家和本机没存密钥的账号不在里面,逐条写在 `skipped`。
   */
  exportForMove: async () => exportAccountsForMove(moveDeps),

  /** 确认框用:这次会带走哪些账号(只有名字,没有密钥)与哪些要在新家重新连。 */
  moveSummary: async () => previewAccountsForMove(moveDeps),

  /** 搬家的另一头:照原样写进这台机器的账号表(不联网校验),返回写了几个、哪些没写。 */
  importFromMove: async (accounts: MovableIntegrationAccount[]) => importAccountsFromMove(moveDeps, accounts),
});

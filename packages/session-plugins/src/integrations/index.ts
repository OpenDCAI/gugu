export { integrationPluginRegistry } from './registry';
export {
  defineIntegrationPlugin,
  INTEGRATION_PLUGIN_ASSETS,
  INTEGRATION_PLUGIN_CAPABILITIES,
  registerIntegrationPluginBehavior,
  type IntegrationAssets,
  type IntegrationCapabilities,
  type IntegrationPluginDefinition,
  type IntegrationPluginMetadata,
  type IntegrationPlaybook,
  type IntegrationPluginProvider,
} from './plugin';
export type {
  ConnectedIntegrationHostContext,
  IntegrationCredentials,
  IntegrationHostContext,
} from './host';
export type { ConnectionStatus, IntegrationError } from './types';
export { localizedTextSchema, type LocalizedText } from './localized-text';
export {
  cliConnectionRecordSchema,
  type CliConnectionRecord,
} from './helpers/cli-connection';
export { mailAccountSchema, type MailAccount } from './helpers/mail/mail-account';
export {
  listMailFolders,
  readMail,
  searchMail,
  sendMail,
  type MailDraft,
  type MailSearch,
} from './helpers/mail/mail-client';
export {
  accessTokenExpiresSoon,
  mcpOAuthCredentialsSchema,
  toIntegrationCredentials,
  type McpOAuthCredentials,
} from './helpers/mcp-oauth';
export type {
  IIntegrationAuthBehavior,
  IntegrationAuthDescriptor,
  IntegrationAuthField,
  IntegrationAuthMethod,
  IntegrationCliMethod,
  IntegrationCliTool,
  VerifyResult,
} from './capabilities/auth';

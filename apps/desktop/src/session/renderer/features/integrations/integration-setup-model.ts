import type { IntegrationMetadata } from './integrations-provider';
import type { IntegrationFormInput } from './types';

// 连一家集成时「它走哪条路、表单怎么填」的纯判断。桌面连接弹窗(integration-setup-modal.tsx)与手机助理 App 的连接页
// 共用,两端只画法不同:这里不碰界面、不碰 rpc。

type AuthMethods = IntegrationMetadata['auth']['methods'];
export type FormAuthMethod = Extract<AuthMethods[number], { kind: 'form' }>;
export type CliAuthMethod = Extract<AuthMethods[number], { kind: 'cli' }>;
type Authable = { auth: { methods: readonly { kind: string }[] } };

export function formMethodOf(metadata: Authable | undefined): FormAuthMethod | undefined {
  const method = (metadata?.auth.methods as AuthMethods | undefined)?.find((candidate) => candidate.kind === 'form');
  return method?.kind === 'form' ? method : undefined;
}

export function cliMethodOf(metadata: Authable): CliAuthMethod | undefined {
  const method = (metadata.auth.methods as AuthMethods).find((candidate) => candidate.kind === 'cli');
  return method?.kind === 'cli' ? method : undefined;
}

export function usesBrowserAuthorization(metadata: Authable): boolean {
  return metadata.auth.methods.some((method) => method.kind === 'mcp-oauth');
}

/** 浏览器授权(mcp-oauth)那一家要去的授权服务地址;不是这条路 = null。 */
export function mcpOAuthServerUrlOf(metadata: Authable): string | null {
  const method = (metadata.auth.methods as AuthMethods).find((candidate) => candidate.kind === 'mcp-oauth');
  return method?.kind === 'mcp-oauth' ? method.serverUrl : null;
}

type FormField = FormAuthMethod['fields'][number];

/** 表单的初值:「编辑凭据」预填存着的不保密项,没有就用插件给的默认值。 */
export function initialFormValues(
  fields: readonly FormField[],
  editFields?: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.id, editFields?.[field.id] ?? field.defaultValue ?? '']));
}

/** 必填的都填了才能提交;「编辑凭据」时保密项留空 = 沿用存着的,不算缺。 */
export function canSubmitForm(
  fields: readonly FormField[],
  values: Readonly<Record<string, string>>,
  editing: boolean
): boolean {
  return fields.every((field) => !field.required || (editing && field.secret) || !!values[field.id]?.trim());
}

/** 交给 `connect` 的那份输入:每格去掉首尾空白。 */
export function formInputOf(
  fields: readonly FormField[],
  values: Readonly<Record<string, string>>
): IntegrationFormInput {
  return Object.fromEntries(fields.map((field) => [field.id, values[field.id]?.trim() ?? '']));
}

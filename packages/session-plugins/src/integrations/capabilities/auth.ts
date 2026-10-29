import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';
import type { IntegrationCredentials, IntegrationHostContext } from '../host';
import type { IntegrationError } from '../types';
import { localizedTextSchema } from '../localized-text';

const authFieldSchema = z.object({
  id: z.string(),
  label: localizedTextSchema,
  secret: z.boolean().default(false),
  required: z.boolean().default(true),
  placeholder: localizedTextSchema.optional(),
  defaultValue: z.string().optional(),
});

/**
 * A vendor's hosted MCP that authorizes with the person's own key in the URL (AMap: `?key=`), not OAuth.
 * With `custody: 'platform'` this is only the fallback for an installation that has no platform service
 * (#921): there the device keeps the key and builds the address itself; everywhere else the platform's
 * provider table holds the address and the key placement.
 */
const keyedMcpSchema = z.object({
  serverUrl: z.string(),
  /** The form field that holds the key. */
  keyField: z.string(),
  /** The query parameter the vendor reads the key from. */
  keyQueryParam: z.string(),
  /**
   * One cheap read-only call that proves the key works. Some vendors (AMap) list their tools for
   * any well-formed key and only reject it on a real call, so listing tools alone would connect a
   * wrong key.
   */
  probe: z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }).optional(),
});

const formMethodSchema = z.object({
  kind: z.literal('form'),
  fields: z.array(authFieldSchema).min(1),
  help: localizedTextSchema.optional(),
  helpUrl: z.string().optional(),
  /**
   * #921 `'platform'`: the person types the credential once and the Gugu platform keeps it for them. The form goes
   * to the platform, which checks it with the provider before storing it; every device of theirs (their cloud
   * computer too) uses the provider's MCP tools through the platform's forwarder, and the credential never comes
   * back to any device. The plugin declares its id and the fields only: the upstream address and where the
   * credential goes on it live in the platform's provider table. Absent = kept in this device's credential store.
   * The one exception is an installation with no such platform service at all (a self-hosted install without the
   * cloud-computer controller): only there the credential is kept on the device, through `mcp`.
   */
  custody: z.literal('platform').optional(),
  mcp: keyedMcpSchema.optional(),
});

const oauthMethodSchema = z.object({
  kind: z.literal('oauth'),
  providerId: z.string(),
});

const oauthDeviceMethodSchema = z.object({
  kind: z.literal('oauth-device'),
  clientId: z.string(),
  scopes: z.array(z.string()),
});

const cliImportMethodSchema = z.object({
  kind: z.literal('cli-import'),
  cli: z.string(), // e.g "gh"
});

/**
 * Remote MCP server that authorizes with OAuth (discovery, dynamic client
 * registration, PKCE), e.g. Notion's hosted MCP. The host runs the browser
 * flow and persists the resulting record; plugins only read it.
 */
const mcpOAuthMethodSchema = z.object({
  kind: z.literal('mcp-oauth'),
  serverUrl: z.string(),
});

/**
 * A vendor's official command-line tool (DingTalk `dws`, WeCom `wecom-cli`). Gugu installs it in
 * its own directory on the machine the integration is connected on, runs the tool's own login,
 * and hands sessions on that machine the tool (on PATH) and its Agent Skills. The tool keeps its
 * own login; gugu only keeps a record that it is connected.
 */
const cliMethodSchema = z.object({
  kind: z.literal('cli'),
  /** Which tool the host knows how to install and drive. */
  tool: z.enum(['dws', 'wecom-cli', 'lark-cli', 'tmeet']),
  /** What the person does to log in: open a link and approve (device flow) or scan a QR code. */
  login: z.enum(['device-link', 'qr-code']),
  /** Something that must be done first, by whom and where — e.g. a DingTalk org admin enabling CLI access. */
  prerequisite: z
    .object({ text: localizedTextSchema, url: z.string().optional() })
    .optional(),
});

const authMethodSchema = z.discriminatedUnion('kind', [
  formMethodSchema,
  oauthMethodSchema,
  oauthDeviceMethodSchema,
  cliImportMethodSchema,
  mcpOAuthMethodSchema,
  cliMethodSchema,
]);

const authDescriptorSchema = z.object({
  methods: z.array(authMethodSchema).min(1),
});

export type IntegrationAuthField = z.infer<typeof authFieldSchema>;
export type IntegrationAuthMethod = z.infer<typeof authMethodSchema>;
export type IntegrationKeyedMcp = z.infer<typeof keyedMcpSchema>;
export type IntegrationCliMethod = z.infer<typeof cliMethodSchema>;
export type IntegrationCliTool = IntegrationCliMethod['tool'];
export type IntegrationAuthDescriptor = z.infer<typeof authDescriptorSchema>;

export type VerifyResult =
  | {
      connected: true;
      /**
       * Stable identity for account upsert/dedupe. Required for multi-account
       * services; single-account services may omit it.
       */
      account?: {
        /** Provider-side stable id, e.g. the GitHub user id. */
        id: string;
        login: string;
        avatarUrl?: string;
        /** Service host when it varies per account, e.g. a GHES instance. */
        host?: string;
      };
      displayName?: string; // user or workspace name
      displayDetail?: string; // e.g. organization or host
      /**
       * Normalized record for the host to persist when it differs from the
       * verified input (e.g. derived ids resolved during validation). When
       * omitted, the host persists the input credentials as-is.
       */
      credentials?: IntegrationCredentials;
    }
  /**
   * `error` 是这一家已经分好类的那一份(`toIntegrationError`):界面按 `type` 用界面语言说,原话放在悬停里。
   * ❌ 只交 `message` —— 那是一句写死的英文,中文界面上照样是英文(10-07 资源库体检)。
   */
  | { connected: false; error?: IntegrationError };

export type IIntegrationAuthBehavior = {
  verify(host: IntegrationHostContext, credentials: IntegrationCredentials): Promise<VerifyResult>;
};

export const integrationAuthCapability = definePluginCapability<IIntegrationAuthBehavior>()(
  'auth',
  authDescriptorSchema
);

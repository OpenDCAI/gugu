import type { PluginFs } from '../../runtime/fs';
import type { ConfigFileTrustBehavior, TrustContext } from '../capabilities/trust';

export type JsonConfigTrustBehaviorOptions = {
  configName: string;
  withTrustedPath: (
    config: Record<string, unknown>,
    workspacePath: string,
    ctx: TrustContext
  ) => Record<string, unknown> | null;
  parseConfig?: (raw: string, configName: string) => Record<string, unknown>;
  stringifyConfig?: (
    raw: string,
    config: Record<string, unknown>,
    configName: string
  ) => string;
  parseErrorMessage?: (configName: string, error: unknown) => string;
};

export function buildJsonConfigTrustBehavior({
  configName,
  withTrustedPath,
  parseConfig: parseConfigOverride,
  stringifyConfig,
  parseErrorMessage,
}: JsonConfigTrustBehaviorOptions): ConfigFileTrustBehavior {
  return {
    channel: 'config-file',
    async trustWorkspace(fs: PluginFs, ctx): Promise<void> {
      const raw = await fs.read(configName);
      let config: Record<string, unknown>;
      try {
        config = parseConfigOverride
          ? parseConfigOverride(raw ?? '', configName)
          : parseConfig(raw, configName, parseErrorMessage);
      } catch (error: unknown) {
        if (parseConfigOverride) {
          throw new Error(
            parseErrorMessage?.(configName, error) ??
              `refusing to overwrite unreadable config ${configName}: ${String(error)}`
          );
        }
        throw error;
      }

      const nextConfig = withTrustedPath(config, ctx.workspacePath, ctx);
      if (!nextConfig) return;

      const output = stringifyConfig
        ? stringifyConfig(raw ?? '', nextConfig, configName)
        : JSON.stringify(nextConfig, null, 2) + '\n';
      await fs.write(configName, output);
    },
  };
}

function parseConfig(
  raw: string | null,
  configName: string,
  parseErrorMessage?: (configName: string, error: unknown) => string
): Record<string, unknown> {
  if (!raw || raw.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(
      parseErrorMessage?.(configName, error) ??
        `refusing to overwrite corrupt config ${configName}: ${String(error)}`
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`refusing to overwrite non-object config root in ${configName}`);
  }
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

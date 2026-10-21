import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { buildJsonConfigTrustBehavior } from '@gugu/session-core/agents/plugins/helpers';

function withCopilotTrustedFolder(
  config: Record<string, unknown>,
  workspacePath: string
): Record<string, unknown> | null {
  const trustedFolders = Array.isArray(config.trustedFolders) ? config.trustedFolders : [];
  if (trustedFolders.includes(workspacePath)) return null;

  return {
    ...config,
    trustedFolders: [...trustedFolders, workspacePath],
  };
}

export function buildCopilotTrustBehavior() {
  return buildJsonConfigTrustBehavior({
    configName: '.copilot/config.json',
    withTrustedPath: withCopilotTrustedFolder,
    parseConfig: parseCopilotConfig,
    stringifyConfig: stringifyCopilotConfig,
    parseErrorMessage: (configName, error) =>
      `refusing to overwrite unreadable JSONC config ${configName}: ${String(error)}`,
  });
}

function parseCopilotConfig(raw: string, configName: string): Record<string, unknown> {
  if (!raw || raw.trim() === '') return {};

  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`parse errors in ${configName}: ${errors.map((error) => error.error).join(', ')}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`non-object config root in ${configName}`);
  }
  return parsed;
}

function stringifyCopilotConfig(raw: string, config: Record<string, unknown>): string {
  const edits = modify(raw, ['trustedFolders'], config.trustedFolders, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const next = applyEdits(raw, edits);
  return next.endsWith('\n') ? next : `${next}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

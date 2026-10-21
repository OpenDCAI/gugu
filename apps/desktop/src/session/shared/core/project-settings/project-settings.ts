import type { Result } from '@gugu/session-shared';
import z from 'zod';

export const PROJECT_CONFIG_FILE = '.gugu.json';
/**
 * 改名前的文件名。这份配置是**提交进仓库、给队友共享**的,所以用户的仓里可能早就有一份;
 * 只认新名字 = 那些仓的团队默认配置从此静默失效。**只读,不写** —— 新写出来的一律是新名字。
 */
export const LEGACY_PROJECT_CONFIG_FILE = '.emdash.json';
/** 读取时的候选顺序:新名优先,旧名兜底。 */
export const PROJECT_CONFIG_FILE_NAMES = [PROJECT_CONFIG_FILE, LEGACY_PROJECT_CONFIG_FILE] as const;

export function isProjectConfigPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return PROJECT_CONFIG_FILE_NAMES.some(
    (name) => normalized === name || normalized.endsWith(`/${name}`)
  );
}

export const DEFAULT_PRESERVE_PATTERNS = [
  '.env',
  '.env.keys',
  '.env.local',
  '.env.*.local',
  '.envrc',
  'docker-compose.override.yml',
] as const;

export const defaultBranchSettingSchema = z.union([
  z.string(),
  z.object({ name: z.string(), remote: z.literal(true) }),
]);

export type DefaultBranchSetting = z.infer<typeof defaultBranchSettingSchema>;

const preservePatternsSchema = z
  .array(z.string())
  .transform((patterns) => patterns.filter((pattern) => pattern !== PROJECT_CONFIG_FILE));

export const shareableProjectScriptsSettingsSchema = z.object({
  setup: z.string().optional(),
  run: z.string().optional(),
  teardown: z.string().optional(),
});

export const shareableProjectSettingsSchema = z.object({
  preservePatterns: preservePatternsSchema.optional(),
  shellSetup: z.string().optional(),
  scripts: shareableProjectScriptsSettingsSchema.optional(),
});

export const shareableProjectSettingsWithDefaultsSchema = shareableProjectSettingsSchema.extend({
  preservePatterns: preservePatternsSchema.default([...DEFAULT_PRESERVE_PATTERNS]),
});

export type ShareableProjectSettings = z.infer<typeof shareableProjectSettingsSchema>;

export const baseProjectSettingsSchema = z.object({
  defaultBranch: defaultBranchSettingSchema.optional(),
  baseRemote: z.string().optional(),
  pushRemote: z.string().optional(),
  githubAccountId: z.string().trim().min(1).nullable().optional(),
  tmux: z.boolean().optional(),
  autoRunSetupScriptOnSessionCreation: z.boolean().optional(),
  autoRunRunScriptOnSessionCreation: z.boolean().optional(),
});

export type BaseProjectSettings = z.infer<typeof baseProjectSettingsSchema>;

export const legacyBaseProjectSettingsSchema = baseProjectSettingsSchema.extend({
  remote: z.string().optional(),
});

export const projectSettingsSchema = baseProjectSettingsSchema.merge(
  shareableProjectSettingsSchema
);

export const legacyProjectConfigSchema = legacyBaseProjectSettingsSchema.merge(
  shareableProjectSettingsSchema
);

export function defaultShareableProjectSettings(): ShareableProjectSettings {
  return shareableProjectSettingsWithDefaultsSchema.parse({});
}

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export type ProjectSettingsLoadError =
  | { type: 'not_found'; entity: 'workspace'; workspaceId: string }
  | { type: 'fs_error'; message: string };

export type ProjectSettingsLoadResult = Result<ProjectSettings, ProjectSettingsLoadError>;

export type ProjectSettingsPatch = {
  clearShareableFields?: ShareableProjectSettingsWriteField[];
  githubAccountId?: string | null;
};

export type ProjectSettingsPage = {
  settings: ProjectSettings;
  writeTargets: ProjectSettingsWriteTargetOption[];
  overrideState: ProjectSettingsOverrideState;
  configMigrations: ProjectConfigMigration[];
  shouldPromptConfigMigration: boolean;
};

export type ProjectSettingsWriteTarget =
  | { type: 'project' }
  | { type: 'workspace'; workspaceId: string };

export type ProjectSettingsWriteTargetOption = ProjectSettingsWriteTarget & {
  label: string;
  path: string;
};

export type ShareableProjectSettingsWriteField =
  | 'preservePatterns'
  | 'shellSetup'
  | 'scripts.setup'
  | 'scripts.run'
  | 'scripts.teardown';

export const SHAREABLE_PROJECT_SETTINGS_WRITE_FIELDS = [
  'preservePatterns',
  'shellSetup',
  'scripts.setup',
  'scripts.run',
  'scripts.teardown',
] as const satisfies ShareableProjectSettingsWriteField[];

export type WriteProjectConfigRequest = {
  target: ProjectSettingsWriteTarget;
  fields: ShareableProjectSettingsWriteField[];
};

export type ProjectSettingsOverrideSource = {
  label: string;
  path: string;
  value: string;
};

export type ProjectSettingsOverrideState = Record<
  ShareableProjectSettingsWriteField,
  ProjectSettingsOverrideSource[]
>;

export type ProjectConfigMigrationProvider = 'conductor' | 'superset' | 'paseo' | 'codex';

export type ProjectConfigMigration = {
  provider: ProjectConfigMigrationProvider;
  label: string;
  files: string[];
  fields: ShareableProjectSettingsWriteField[];
  unsupportedFields: string[];
};

export type ProjectConfigMigrationDestination = 'local' | 'shared';

export type MigrateProjectConfigRequest = {
  provider: ProjectConfigMigrationProvider;
  destination: ProjectConfigMigrationDestination;
};

export type MigrateProjectConfigResult = {
  page: ProjectSettingsPage;
  migration: ProjectConfigMigration;
};

export function emptyProjectSettingsOverrideState(): ProjectSettingsOverrideState {
  return {
    preservePatterns: [],
    shellSetup: [],
    'scripts.setup': [],
    'scripts.run': [],
    'scripts.teardown': [],
  };
}

import type { GitBranchRef } from '@gugu/session-core/git';
import { projectDefaultBranchToBranch } from '@shared/core/git/utils';
import type {
  ProjectSettings,
  ShareableProjectSettingsWriteField,
} from '@shared/core/project-settings/project-settings';
import {
  SHAREABLE_FIELD_DESCRIPTOR_BY_ID,
  SHAREABLE_FIELD_DESCRIPTORS,
  SHAREABLE_FIELD_FORM_KEY,
} from './shareable-project-settings-fields';

export type FormState = {
  preservePatterns: string;
  shellSetup: string;
  tmux: boolean;
  autoRunSetupScriptOnSessionCreation: boolean;
  autoRunRunScriptOnSessionCreation: boolean;
  scriptSetup: string;
  scriptRun: string;
  scriptTeardown: string;
  defaultBranch: GitBranchRef | null;
  baseRemote: string;
  pushRemote: string;
  githubAccountId: string | null | undefined;
};

export type FormUpdate = <K extends keyof FormState>(key: K, value: FormState[K]) => void;

function normalizeScript(val: string | string[] | undefined): string {
  if (Array.isArray(val)) return val.join('\n');
  return val ?? '';
}

function blankToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function githubAccountIdToSettings(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return value.trim() || null;
}

export function settingsToForm(
  s: ProjectSettings,
  baseRemote: string,
  remotes: { name: string; url: string }[]
): FormState {
  const baseRemoteMeta = remotes.find((remote) => remote.name === baseRemote) ?? {
    name: baseRemote,
    url: '',
  };

  return {
    preservePatterns: (s.preservePatterns ?? []).join('\n'),
    shellSetup: s.shellSetup ?? '',
    tmux: s.tmux ?? false,
    autoRunSetupScriptOnSessionCreation: s.autoRunSetupScriptOnSessionCreation ?? true,
    autoRunRunScriptOnSessionCreation: s.autoRunRunScriptOnSessionCreation ?? false,
    scriptSetup: normalizeScript(s.scripts?.setup),
    scriptRun: normalizeScript(s.scripts?.run),
    scriptTeardown: normalizeScript(s.scripts?.teardown),
    defaultBranch: projectDefaultBranchToBranch(s.defaultBranch, baseRemoteMeta, remotes) ?? null,
    baseRemote: s.baseRemote ?? '',
    pushRemote: s.pushRemote ?? '',
    githubAccountId: Object.hasOwn(s, 'githubAccountId') ? (s.githubAccountId ?? null) : undefined,
  };
}

export function formToSettings(f: FormState): ProjectSettings {
  let defaultBranch: ProjectSettings['defaultBranch'];
  if (f.defaultBranch) {
    defaultBranch =
      f.defaultBranch.type === 'remote'
        ? `${f.defaultBranch.remote.name}/${f.defaultBranch.branch}`
        : f.defaultBranch.branch;
  }
  const preservePatterns = f.preservePatterns
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
  const scripts = {
    setup: blankToUndefined(f.scriptSetup),
    run: blankToUndefined(f.scriptRun),
    teardown: blankToUndefined(f.scriptTeardown),
  };
  const githubAccountId = githubAccountIdToSettings(f.githubAccountId);
  const hasScripts = Object.values(scripts).some((value) => value !== undefined);
  return {
    preservePatterns: preservePatterns.length > 0 ? preservePatterns : undefined,
    shellSetup: blankToUndefined(f.shellSetup),
    tmux: f.tmux,
    ...(f.autoRunSetupScriptOnSessionCreation ? {} : { autoRunSetupScriptOnSessionCreation: false }),
    ...(f.autoRunRunScriptOnSessionCreation ? { autoRunRunScriptOnSessionCreation: true } : {}),
    scripts: hasScripts ? scripts : undefined,
    defaultBranch,
    baseRemote: blankToUndefined(f.baseRemote),
    pushRemote:
      f.pushRemote.trim() && f.pushRemote.trim() !== f.baseRemote.trim()
        ? f.pushRemote.trim()
        : undefined,
    ...(githubAccountId !== undefined ? { githubAccountId } : {}),
  };
}

export function normalizeShareableFieldValue(
  field: ShareableProjectSettingsWriteField,
  value: string
): string {
  return SHAREABLE_FIELD_DESCRIPTOR_BY_ID[field].normalizeText(value);
}

export function getAvailableWriteFields(form: FormState): ShareableProjectSettingsWriteField[] {
  return SHAREABLE_FIELD_DESCRIPTORS.map((descriptor) => descriptor.id).filter((field) =>
    String(form[SHAREABLE_FIELD_FORM_KEY[field]]).trim()
  );
}

export function areFormStatesEqual(a: FormState, b: FormState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

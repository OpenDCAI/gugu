import type { SessionMessageKey } from '@renderer/localization/messages';
import type { ShareableProjectSettingsWriteField } from '@shared/core/project-settings/project-settings';

export type ShareableFieldFormKey =
  | 'preservePatterns'
  | 'shellSetup'
  | 'scriptSetup'
  | 'scriptRun'
  | 'scriptTeardown';

export type ShareableFieldDescriptor = {
  id: ShareableProjectSettingsWriteField;
  formKey: ShareableFieldFormKey;
  modalLabelKey: SessionMessageKey;
  leafLabelKey: SessionMessageKey;
  defaultWrite: boolean;
  normalizeText(value: string): string;
  placeholder?: string;
  descriptionKey?: SessionMessageKey;
  multiline: boolean;
  group?: 'lifecycle';
};

function trimText(value: string): string {
  return value.trim();
}

function normalizePatternList(value: string): string {
  return value
    .split('\n')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .join('\n');
}

export const SHAREABLE_FIELD_DESCRIPTORS: ShareableFieldDescriptor[] = [
  {
    id: 'preservePatterns',
    formKey: 'preservePatterns',
    modalLabelKey: 'projects.settings.field.preservePatterns',
    leafLabelKey: 'projects.settings.field.preservePatternsLeaf',
    defaultWrite: true,
    normalizeText: normalizePatternList,
    placeholder: '.env\n.env.local',
    descriptionKey: 'projects.settings.field.preservePatternsDescription',
    multiline: true,
  },
  {
    id: 'shellSetup',
    formKey: 'shellSetup',
    modalLabelKey: 'projects.settings.field.shellSetup',
    leafLabelKey: 'projects.settings.field.shellSetupLeaf',
    defaultWrite: true,
    normalizeText: trimText,
    placeholder: 'nvm use\nsource .envrc',
    descriptionKey: 'projects.settings.field.shellSetupDescription',
    multiline: true,
  },
  {
    id: 'scripts.setup',
    formKey: 'scriptSetup',
    modalLabelKey: 'projects.settings.field.scriptSetup',
    leafLabelKey: 'projects.settings.field.scriptSetupLeaf',
    defaultWrite: true,
    normalizeText: trimText,
    placeholder: 'npm install\ncp .env.example .env',
    multiline: true,
    group: 'lifecycle',
  },
  {
    id: 'scripts.run',
    formKey: 'scriptRun',
    modalLabelKey: 'projects.settings.field.scriptRun',
    leafLabelKey: 'projects.settings.field.scriptRunLeaf',
    defaultWrite: true,
    normalizeText: trimText,
    placeholder: 'npm run dev',
    multiline: true,
    group: 'lifecycle',
  },
  {
    id: 'scripts.teardown',
    formKey: 'scriptTeardown',
    modalLabelKey: 'projects.settings.field.scriptTeardown',
    leafLabelKey: 'projects.settings.field.scriptTeardownLeaf',
    defaultWrite: true,
    normalizeText: trimText,
    placeholder: 'docker compose down',
    multiline: true,
    group: 'lifecycle',
  },
];

export const SHAREABLE_FIELD_DESCRIPTOR_BY_ID = Object.fromEntries(
  SHAREABLE_FIELD_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor])
) as Record<ShareableProjectSettingsWriteField, ShareableFieldDescriptor>;

export const DEFAULT_WRITE_FIELDS = SHAREABLE_FIELD_DESCRIPTORS.filter(
  (descriptor) => descriptor.defaultWrite
).map((descriptor) => descriptor.id);

export const SHAREABLE_FIELD_FORM_KEY = Object.fromEntries(
  SHAREABLE_FIELD_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.formKey])
) as Record<ShareableProjectSettingsWriteField, ShareableFieldFormKey>;

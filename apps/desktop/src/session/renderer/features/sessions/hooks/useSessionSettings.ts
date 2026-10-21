import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { DEFAULT_SESSION_AUTO_APPROVE } from '@shared/core/sessions/default-session-autonomy';

export interface SessionSettingsModel {
  autoGenerateName: boolean;
  autoApproveByDefault: boolean;
  autoTrustWorktrees: boolean;
  preserveNameCapitalization: boolean;
  includeIssueContextByDefault: boolean;
  loading: boolean;
  saving: boolean;
  isFieldOverridden: (
    field:
      | 'autoGenerateName'
      | 'autoApproveByDefault'
      | 'autoTrustWorktrees'
      | 'preserveNameCapitalization'
      | 'includeIssueContextByDefault'
  ) => boolean;
  updateAutoGenerateName: (next: boolean) => void;
  updateAutoApproveByDefault: (next: boolean) => void;
  updateAutoTrustWorktrees: (next: boolean) => void;
  updatePreserveNameCapitalization: (next: boolean) => void;
  updateIncludeIssueContextByDefault: (next: boolean) => void;
  resetAutoGenerateName: () => void;
  resetAutoApproveByDefault: () => void;
  resetAutoTrustWorktrees: () => void;
  resetPreserveNameCapitalization: () => void;
  resetIncludeIssueContextByDefault: () => void;
}

export function useSessionSettings(): SessionSettingsModel {
  const {
    value: sessions,
    isLoading: loading,
    isSaving: saving,
    isFieldOverridden,
    update,
    resetField,
  } = useAppSettingsKey('sessions');

  return {
    autoGenerateName: sessions?.autoGenerateName ?? false,
    autoApproveByDefault: sessions?.autoApproveByDefault ?? DEFAULT_SESSION_AUTO_APPROVE,
    autoTrustWorktrees: sessions?.autoTrustWorktrees ?? false,
    preserveNameCapitalization: sessions?.preserveNameCapitalization ?? false,
    includeIssueContextByDefault: sessions?.includeIssueContextByDefault ?? true,
    loading,
    saving,
    isFieldOverridden,
    updateAutoGenerateName: (next) => update({ autoGenerateName: next }),
    updateAutoApproveByDefault: (next) => update({ autoApproveByDefault: next }),
    updateAutoTrustWorktrees: (next) => update({ autoTrustWorktrees: next }),
    updatePreserveNameCapitalization: (next) => update({ preserveNameCapitalization: next }),
    updateIncludeIssueContextByDefault: (next) => update({ includeIssueContextByDefault: next }),
    resetAutoGenerateName: () => resetField('autoGenerateName'),
    resetAutoApproveByDefault: () => resetField('autoApproveByDefault'),
    resetAutoTrustWorktrees: () => resetField('autoTrustWorktrees'),
    resetPreserveNameCapitalization: () => resetField('preserveNameCapitalization'),
    resetIncludeIssueContextByDefault: () => resetField('includeIssueContextByDefault'),
  };
}

import { CommandPaletteModal } from '@renderer/features/command-palette/command-palette-modal'
import { KeyboardShortcutsCheatSheet } from '@renderer/features/settings/components/keyboard-shortcuts-cheat-sheet'
import { IntegrationSetupModal } from '@renderer/features/integrations/integration-setup-modal'
import { PromptModal } from '@renderer/features/library/prompts/prompt-modal'
import { McpServerModal } from '@renderer/features/mcp/components/mcp-server-modal'
import { RenameSessionModal } from '@renderer/features/sessions/rename-session-modal'
import { CreateProjectNameModal } from '@renderer/features/projects/components/create-project-name-modal'
import { LocalFolderProjectModal } from '@renderer/features/projects/components/local-folder-project-modal'
import { AgentSignInModal } from '@renderer/features/settings/agents-page/AgentSignInModal'
import { GithubConnectModal } from '@renderer/features/settings/components/github-connect-modal'
import { AddRemoteModal } from '@renderer/features/sessions/add-remote-modal'
import { HarnessLoginRequiredModal } from '@renderer/features/sessions/session-config/harness-login-required-modal'
import { CreatePrModal } from '@renderer/features/sessions/diff-view/changes-panel/components/pr-entry/create-pr-modal'
import { ConfirmActionDialog } from '@renderer/lib/components/confirm-action-dialog'
import { ExternalLinkChoiceDialog } from '@renderer/lib/components/external-link-choice-dialog'
import { OpenWithChooser } from '@renderer/features/extensions/open-with-chooser'
import { GithubDeviceFlowModal } from '@renderer/lib/components/github-device-flow-modal'
import { UnsavedChangesDialog } from '@renderer/lib/components/unsaved-changes-dialog'
import { createModal, type ModalRegistryEntry } from '@/components/ui/modal-registry'
export type { ModalSize, ModalPosition, ModalRegistryEntry } from '@/components/ui/modal-registry'

export const modalRegistry = {
  commandPaletteModal: createModal(CommandPaletteModal, { size: 'md' }),
  localFolderProjectModal: createModal(LocalFolderProjectModal, { size: 'sm' }),
  createProjectNameModal: createModal(CreateProjectNameModal, { size: 'sm' }),
  githubDeviceFlowModal: createModal(GithubDeviceFlowModal, { size: 'md' }),
  confirmActionModal: createModal(ConfirmActionDialog, { size: 'xs' }),
  confirmExternalLinkModal: createModal(ExternalLinkChoiceDialog, { size: 'sm' }),
  openWithChooserModal: createModal(OpenWithChooser, { size: 'sm' }),
  unsavedChangesModal: createModal(UnsavedChangesDialog, { size: 'xs' }),
  promptModal: createModal(PromptModal, { size: 'lg' }),
  mcpServerModal: createModal(McpServerModal, { size: 'lg' }),
  createPrModal: createModal(CreatePrModal, { size: 'md' }),
  renameSessionModal: createModal(RenameSessionModal, { size: 'xs' }),
  integrationSetupModal: createModal(IntegrationSetupModal, { size: 'md' }),
  githubConnectModal: createModal(GithubConnectModal, { size: 'md' }),
  agentSignInModal: createModal(AgentSignInModal, { size: 'lg' }),
  addRemoteModal: createModal(AddRemoteModal),
  harnessLoginRequiredModal: createModal(HarnessLoginRequiredModal, { size: 'sm' }),
  keyboardShortcutsModal: createModal(KeyboardShortcutsCheatSheet, { size: 'lg' }),
} satisfies Record<string, ModalRegistryEntry<any, any>>

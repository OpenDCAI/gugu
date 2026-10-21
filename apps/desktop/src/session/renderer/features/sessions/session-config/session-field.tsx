import { InitialSessionField } from '@renderer/features/sessions/session-config/initial-session-section';
import { useSessionState } from './session-state-context';

interface SessionFieldProps {
  placeholder?: string;
  textareaClassName?: string;
  enableMentions?: boolean;
  onPromptBlur?: () => void;
  showAutoApproveToggle?: boolean;
  /** 这一面收不收附件,见 InitialSessionField 的同名 prop。 */
  enableAttachments?: boolean;
  /** When provided, the send button renders inline in the composer toolbar. */
  onSubmit?: () => void;
  canSubmit?: boolean;
}

export function SessionField({
  placeholder,
  textareaClassName,
  enableMentions,
  onPromptBlur,
  showAutoApproveToggle,
  enableAttachments,
  onSubmit,
  canSubmit,
}: SessionFieldProps) {
  const { initialSession, linkedIssue, includeIssueContextByDefault } = useSessionState();

  return (
    <InitialSessionField
      state={initialSession}
      linkedIssue={linkedIssue}
      includeIssueContextByDefault={includeIssueContextByDefault}
      enableMentions={enableMentions}
      placeholder={placeholder}
      textareaClassName={textareaClassName}
      onPromptBlur={onPromptBlur}
      showAutoApproveToggle={showAutoApproveToggle}
      enableAttachments={enableAttachments}
      onSubmit={onSubmit}
      canSubmit={canSubmit}
    />
  );
}

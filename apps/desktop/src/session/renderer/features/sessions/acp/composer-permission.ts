import type { ComposerPermissionRequest } from '@gugu/session-ui/react/components';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';
import type { AcpChatStore } from './acp-chat-store';

/** Map an AcpPermissionRequest to the ComposerPermissionRequest shape the UI expects. */
export function toComposerPermission(
  req: AcpChatStore['permissionQueue'][number] | undefined,
  translate: (key: SessionMessageLookupKey) => string,
  inTranscript: (toolCallId: string) => boolean = () => false,
): ComposerPermissionRequest | null {
  // 计划审批画在流里的计划卡上，选项也在卡上（#7139）⇒ 卡已在流里时输入框上不再出这一条。
  if (!req || (req.waitKind === 'plan' && inTranscript(req.toolCallId))) return null;
  const optionLabel = (kind: string): string | undefined => {
    switch (kind) {
      case 'allow_once':
        return translate('composer.allowOnce');
      case 'allow_always':
        return translate('composer.allowAlways');
      case 'reject_once':
        return translate('composer.rejectOnce');
      case 'reject_always':
        return translate('composer.rejectAlways');
      default:
        return undefined;
    }
  };
  // A label must name exactly one option: a question's options are the provider's own choices, and a request offering
  // two options of one kind keeps their names — Hermes' "this session" and "always" are both allow_always, and Claude's
  // plan review offers three allow_always ("…clear context and use auto mode", "…use auto mode", "…bypass permissions").
  const shared = (kind: string) => req.options.filter((option) => option.kind === kind).length > 1;
  return {
    requestId: req.requestId,
    title: req.title,
    statusLabel: translate('composer.awaitingApproval'),
    options: req.options.map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
      label: req.waitKind === 'question' || shared(o.kind) ? undefined : optionLabel(o.kind),
    })),
  };
}

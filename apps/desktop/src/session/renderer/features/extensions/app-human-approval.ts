import type { GuguLinkTarget } from '@gugu/core/shared/ui/guguLink';
import { APP_HUMAN_CANCEL, APP_HUMAN_COMPLETE, APP_HUMAN_OPEN, type AppHumanAsk } from '@shared/extensions/app-human';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';

export function appHumanWords(ask: AppHumanAsk,
  translate: (key: SessionMessageLookupKey, params?: Readonly<Record<string, string | number>>) => string,
) {
  return {
    title: `${ask.appName}: ${ask.title}`,
    label: (optionId: string) => optionId === APP_HUMAN_COMPLETE ? translate('extensions.humanComplete')
      : optionId === APP_HUMAN_CANCEL ? translate('common.cancel')
      : optionId === APP_HUMAN_OPEN ? translate('extensions.humanOpenApp') : undefined,
  };
}

/** Opening the related tab is navigation, never the answer to the request. */
export function appHumanTarget(ask: AppHumanAsk): GuguLinkTarget | null {
  return ask.tab ? { kind: 'app', extensionId: ask.extensionId, tab: ask.tab, path: '', query: {}, place: { session: ask.sessionId } } : null;
}

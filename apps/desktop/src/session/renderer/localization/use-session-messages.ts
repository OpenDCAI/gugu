import { useLocale } from '@/i18n';
import type { SessionMessageLookupKey } from './messages';
import { translateSessionMessage, type SessionMessageValues } from './locale-store';

/**
 * The session page's own words, in the app's language. Read from the app's locale, not from session-ui's
 * MessageProvider: that context is how the session-ui package is handed its words, and this page's components are drawn
 * outside it too (a file opened beside an App in a chat's panel).
 */
export function useSessionMessages() {
  const { resolvedLocale: locale } = useLocale();
  return {
    locale,
    translate: (key: SessionMessageLookupKey, values?: SessionMessageValues) => translateSessionMessage(key, values),
  };
}

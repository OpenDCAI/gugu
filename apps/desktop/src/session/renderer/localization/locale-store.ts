import {
  getLocaleSnapshot,
  i18n,
  registerLocaleNamespace,
  subscribeLocale,
  type SupportedLocale,
} from '@/i18n';
import { enUSMessages, type SessionMessageKey, zhCNMessages } from './messages';

export type SessionLocale = SupportedLocale;
export type SessionMessageValues = Readonly<Record<string, string | number>>;

let registered = false;

export function registerSessionLocaleResources(): void {
  if (registered) return;
  registerLocaleNamespace('session', {
    'zh-CN': zhCNMessages,
    'en-US': enUSMessages,
  });
  registered = true;
}

export function getSessionLocaleSnapshot() {
  return getLocaleSnapshot();
}

export const subscribeSessionLocale = subscribeLocale;

export function translateSessionMessage(
  messageKey: SessionMessageKey | string,
  values: SessionMessageValues = {}
): string {
  registerSessionLocaleResources();
  const options = {
    ns: 'session',
    ...values,
    interpolation: { prefix: '{', suffix: '}' },
  } as const;
  if (!i18n.exists(messageKey, options)) {
    throw new Error(
      `Missing session translation: ${getLocaleSnapshot().resolvedLocale}:${messageKey}`
    );
  }
  return i18n.t(messageKey, options);
}

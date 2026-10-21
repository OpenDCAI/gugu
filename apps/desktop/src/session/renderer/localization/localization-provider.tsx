import { LocalizationProvider, useLocale } from '@/i18n';
import { MessageProvider } from '@gugu/session-ui/react/components';
import { useEffect, type ReactNode } from 'react';
import { registerSessionLocaleResources, translateSessionMessage } from './locale-store';

registerSessionLocaleResources();

function SessionMessageBridge({ children }: { children: ReactNode }) {
  const { resolvedLocale } = useLocale();

  useEffect(() => {
    const mount = window.__EMDASH_MOUNT__;
    if (mount) mount.lang = resolvedLocale;
  }, [resolvedLocale]);

  return (
    <MessageProvider locale={resolvedLocale} translate={translateSessionMessage}>
      {children}
    </MessageProvider>
  );
}

export function SessionLocalizationProvider({ children }: { children: ReactNode }) {
  return (
    <LocalizationProvider>
      <SessionMessageBridge>{children}</SessionMessageBridge>
    </LocalizationProvider>
  );
}

import * as React from 'react';

export type MessageValues = Readonly<Record<string, string | number>>;
export type MessageTranslator = (key: string, values?: MessageValues) => string;

type MessageContextValue = {
  locale: string;
  translate: MessageTranslator;
};

const MessageContext = React.createContext<MessageContextValue | null>(null);

export function MessageProvider({
  locale,
  translate,
  children,
}: MessageContextValue & { children: React.ReactNode }) {
  const value = React.useMemo(() => ({ locale, translate }), [locale, translate]);
  return <MessageContext.Provider value={value}>{children}</MessageContext.Provider>;
}

export function useMessages(): MessageContextValue {
  const value = React.useContext(MessageContext);
  if (!value) {
    throw new Error('useMessages must be used within a MessageProvider');
  }
  return value;
}

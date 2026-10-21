import type { PropsWithChildren } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n } from './runtime'

export function LocalizationProvider({ children }: PropsWithChildren) {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}


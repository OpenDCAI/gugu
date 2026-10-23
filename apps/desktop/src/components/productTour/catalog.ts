import { registerLocaleNamespace } from '../../i18n/runtime'
import zh from '../../i18n/locales/zh-CN/productTour'
import en from '../../i18n/locales/en-US/productTour'
registerLocaleNamespace('productTour', { 'zh-CN': zh, 'en-US': en })

export const TOUR_MODULES = ['assistant', 'tasks', 'chats', 'contacts', 'library', 'apps', 'settings'] as const
export const TOUR_FEATURES = ['split', 'modes', 'contacts', 'report'] as const

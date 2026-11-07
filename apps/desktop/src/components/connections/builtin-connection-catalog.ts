import { integrationIcons } from '@gugu/session-plugins/integration-icons'
import { cloudComputerEnabled } from '@gugu/core/cloud/optionalServices'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { integrationListCopy } from '../assistant/assistant-panel-integrations'
import bundled from './builtin-catalog.generated.json'

// This serialized public payload is generated from the actual provider registry
// and compared with it in the payload builder's tests.
export function builtinConnectionCatalog(locale: string): IntegrationMetadata[] {
  const entries = bundled.locales[locale === 'zh-CN' ? 'zh-CN' : 'en'] as Omit<IntegrationMetadata, 'icon'>[]
  return entries.map(item => ({ ...item, ...integrationListCopy(item.id, item.name, item.description, locale),
    catalogVersion: bundled.sha256, icon: integrationIcons[item.id]!,
    auth: { ...item.auth, methods: item.auth.methods.map(method => method.kind === 'form' && method.custody === 'platform' && !cloudComputerEnabled()
      ? { ...method, custody: 'local' as const } : method) },
  }))
}

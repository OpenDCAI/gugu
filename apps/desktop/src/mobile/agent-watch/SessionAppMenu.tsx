import { useTranslation } from 'react-i18next'
import { AppWindow, Check, MessageCircle } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { DropdownMenu, menuRowClassName, menuRowLabelClassName } from '@/components/ui/Menu'

/** App navigation around one conversation; there are no chat/task conversation modes. */
export function SessionAppMenu({ appKind, apps, onOpenApp, onConversation }: {
  appKind: string | null; apps: readonly { kind: string; name: string }[]
  onOpenApp: (kind: string) => void; onConversation: () => void
}) {
  const { t } = useTranslation('main')
  if (!apps.length) return null
  const label = apps.find(app => app.kind === appKind)?.name ?? t('shell.chats')
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger render={<Button variant="ghost" size="sm">{appKind ? <AppWindow size={16} /> : <MessageCircle size={16} />}{label}</Button>} />
    <DropdownMenu.Content align="end">
      <DropdownMenu.Item className={menuRowClassName} onClick={onConversation}>
        <MessageCircle size={16} /><span className={menuRowLabelClassName}>{t('shell.chats')}</span>{!appKind ? <Check size={16} /> : null}
      </DropdownMenu.Item>
      {apps.map(app => <DropdownMenu.Item key={app.kind} className={menuRowClassName} onClick={() => onOpenApp(app.kind)}>
        <AppWindow size={16} /><span className={menuRowLabelClassName}>{app.name}</span>{appKind === app.kind ? <Check size={16} /> : null}
      </DropdownMenu.Item>)}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
}

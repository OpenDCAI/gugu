import type { ReactNode } from 'react'
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { Button } from '@renderer/lib/ui/button'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@renderer/lib/ui/select'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import './connection-settings.css'

/** Same connection actions and forms as the subscription menu, placed in the engine dialog. */
export function ConnectionSettingsRows({
  connections,
  open,
  onOpenChange,
  onSelect,
  onAdd,
  busy,
  description,
  notice,
  children,
  form
}: {
  connections: HarnessConnection[] | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (id: string) => void
  onAdd: () => void
  busy: boolean
  description: ReactNode
  notice: ReactNode
  children: ReactNode
  form: ReactNode
}) {
  const { translate } = useSessionMessages()
  const current = connections?.find((c) => c.current)
  const name =
    current?.kind === 'native' ? translate('subscriptions.connections.existing') : current?.name
  return (
    <SettingsGroup
      title={translate('agentsPage.connectionGroup')}
      className="agent-connection-settings"
    >
      <SettingsRow
        title={translate('agentsPage.currentConnection')}
        description={description}
        control={
          <Select
            items={connections?.map((c) => ({
              value: c.id,
              label: c.kind === 'native' ? translate('subscriptions.connections.existing') : c.name
            }))}
            value={current?.id ?? null}
            open={open}
            onOpenChange={onOpenChange}
            onValueChange={(value) => {
              if (value !== null) onSelect(String(value))
            }}
            disabled={busy || !current}
          >
            <SelectTrigger
              className="w-[156px]"
              aria-label={translate('agentsPage.currentConnection')}
            >
              <SelectValue>{name ?? translate('subscriptions.checking')}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[300px]">
              {children}
            </SelectContent>
          </Select>
        }
      >
        {notice}
      </SettingsRow>
      <SettingsRow
        title={translate('subscriptions.connections.add')}
        description={translate('agentsPage.connectionAddHint')}
        control={
          <Button size="sm" variant="outline" disabled={busy} onClick={onAdd}>
            {translate('agentsPage.addConnectionAction')}
          </Button>
        }
      />
      {form}
    </SettingsGroup>
  )
}

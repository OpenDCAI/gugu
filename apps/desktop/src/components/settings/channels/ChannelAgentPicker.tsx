import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown } from '@/lib/icons'
import { Avatar } from '../../Avatar'
import { Button } from '../../ui/Button'
import { DropdownMenu, MenuItem } from '../../ui/Menu'
import { useOwnedAgents } from './channelAgents'

export function ChannelAgentPicker({
  agentId,
  onPick,
  testId,
}: {
  agentId: string | null
  onPick: (agentId: string) => void
  testId?: string
}) {
  const { t } = useTranslation('settings')
  const agents = useOwnedAgents()
  const [open, setOpen] = useState(false)
  const current = agents.find((agent) => agent.id === agentId) ?? null
  if (agents.length === 0) {
    return <span className="text-[length:var(--font-body)] text-[var(--muted-fg)]">{t('channels.noAgents')}</span>
  }
  return (
    <DropdownMenu.Root open={open} modal={false} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        data-testid={testId}
        aria-haspopup="menu"
        render={(
          <Button size="sm" variant={current ? 'secondary' : 'primary'} className="max-w-[220px] shrink-0">
            {current ? <Avatar name={current.display_name} avatarUrl={current.avatar} seed={current.id} size="xs" isAgent harnessBadge={false} /> : null}
            <span className="truncate">{current ? current.display_name : t('channels.pickAgent')}</span>
            <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-60" />
          </Button>
        )}
      />
      {open && (
        <DropdownMenu.Content side="bottom" align="end" sideOffset={4} zIndex="var(--z-settings-modal)" aria-label={t('channels.agentLabel')} className="max-h-[320px] w-[240px] overflow-y-auto">
          {agents.map((agent) => (
            <MenuItem
              key={agent.id}
              data-testid={`channel-agent-option-${agent.id}`}
              onClick={() => {
                setOpen(false)
                if (agent.id !== agentId) onPick(agent.id)
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Avatar name={agent.display_name} avatarUrl={agent.avatar} seed={agent.id} size="xs" isAgent harnessBadge={false} />
                <span className="truncate">{agent.display_name}</span>
                {agent.id === agentId ? <Check aria-hidden className="ml-auto size-4 shrink-0 text-[var(--muted-fg)]" /> : null}
              </span>
            </MenuItem>
          ))}
        </DropdownMenu.Content>
      )}
    </DropdownMenu.Root>
  )
}

import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { createMachineSettingsHost, SettingsHostProvider } from '@renderer/features/settings/settings-host'
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider'
import { Button } from '@renderer/lib/ui/button'
import { ConfirmButton } from '@renderer/lib/ui/confirm-button'
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field'
import { Input } from '@renderer/lib/ui/input'
import { safePathSegment } from '@shared/path-name'
import {
  isProjectPathConflictError,
  projectPathConflictMessage,
} from '../stores/project-creation-error'

type CreateProjectNameProps = BaseModalProps<string> & {
  /** #6264 建在别的机器上(那台机器的默认项目目录,规则同本机)。null / 缺省 = 本机。 */
  machine?: { deviceId: string; label: string } | null
}

export const CreateProjectNameModal = observer(function CreateProjectNameModal(props: CreateProjectNameProps) {
  const { machine } = props
  if (!machine) return <CreateProjectNameForm {...props} machine={null} />
  // 默认项目目录是那台机器的设置(跟机器走的那组),读那台机器的。
  const device = remoteHostsStore.device(machine.deviceId)
  return (
    <SettingsHostProvider
      value={createMachineSettingsHost({
        deviceId: machine.deviceId,
        deviceLabel: machine.label,
        online: remoteHostsStore.connectionState(machine.deviceId) === 'connected',
        lastSeenAt: device?.lastSeenAt ?? null
      })}
    >
      <CreateProjectNameForm {...props} machine={machine} />
    </SettingsHostProvider>
  )
})

const CreateProjectNameForm = observer(function CreateProjectNameForm({
  onClose,
  onSuccess,
  machine
}: CreateProjectNameProps) {
  const { translate } = useSessionMessages()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const { value: settings } = useAppSettingsKey('localProject')
  const defaultDirectory = settings?.defaultProjectsDirectory ?? ''

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || creating) return
    if (!defaultDirectory) {
      setError(translate('projects.create.noDefaultDirectory'))
      return
    }
    if (safePathSegment(trimmed, '') !== trimmed) {
      setError(translate('projects.create.invalidName'))
      return
    }
    setCreating(true)
    setError(null)
    try {
      const projectId = await getProjectManagerStore().createProject(
        machine ? { type: 'local', machine: machine.deviceId } : { type: 'local' },
        {
          mode: 'pick',
          path: `${defaultDirectory}/${trimmed}`,
          name: trimmed,
          createDirectory: true,
          allowNonGit: true
        }
      )
      if (!projectId) throw new Error(translate('projects.create.failed'))
      // 那台机器上的项目:建好就挂上,侧栏里立刻有它(标机器名)。
      if (machine) await getProjectManagerStore().mountProject(projectId)
      onSuccess(projectId)
    } catch (cause) {
      setError(
        isProjectPathConflictError(cause)
          ? projectPathConflictMessage(cause, translate)
          : cause instanceof Error
            ? cause.message
            : translate('projects.create.failed')
      )
      setCreating(false)
    }
  }

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>
          {machine
            ? translate('projects.create.nameTitleOnMachine', { machine: machine.label })
            : translate('projects.create.nameTitle')}
        </DialogTitle>
      </DialogHeader>
      {/* data-testid:e2e task-projects-localization-spacing 拿这张弹窗当 locale/skin 探测面。 */}
      <DialogContentArea className="pt-0" data-testid="create-project-name-modal">
        <FieldGroup>
          <Field>
            <FieldLabel>{translate('projects.create.nameLabel')}</FieldLabel>
            <Input
              autoFocus
              value={name}
              placeholder={translate('projects.create.nameLabel')}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
              }}
            />
            {error && (
              <p
                role="alert"
                data-testid="project-creation-error"
                className="text-foreground-destructive mt-1 text-xs"
              >
                {error}
              </p>
            )}
          </Field>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {translate('projects.create.cancel')}
        </Button>
        <ConfirmButton disabled={!name.trim() || creating} onClick={() => void create()}>
          {translate(creating ? 'projects.create.creating' : 'projects.create.save')}
        </ConfirmButton>
      </DialogFooter>
    </>
  )
})

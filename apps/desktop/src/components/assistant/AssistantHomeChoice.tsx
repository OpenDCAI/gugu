import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { cloudComputerFailureKind } from '@gugu/core/cloud/cloudComputer'
import { refreshCloudComputer } from '../../lib/cloudComputerStore'
import { Button } from '../ui/Button'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { AgentAvatar } from '../agentAvatar/AgentAvatar'
import { CloudComputerRefusal, type CloudComputerActionFailure } from '../settings/CloudComputerSection'

export function AssistantHomeChoice({
  name, member, cloudEnabled, cloudAvailable, canHostHere, busy, error, cloudFailure,
  onCloud, onServer, onComputer, onUpgrade, onBack, draftAvatar,
}: {
  name: string
  member: boolean | null
  cloudEnabled: boolean
  cloudAvailable: boolean
  canHostHere: boolean
  busy: boolean
  error: string | null
  cloudFailure: CloudComputerActionFailure | null
  onCloud: () => void
  onServer: () => void
  onComputer: () => void
  onUpgrade: () => void
  onBack: () => void
  draftAvatar: string
}) {
  const { t } = useTranslation('assistant')
  const { t: tc } = useTranslation('common')
  const cloudCheck = useMutation({ mutationFn: refreshCloudComputer })
  const header = <>
    <AgentAvatar name={name} avatar={draftAvatar} id="assistant-draft" size={72} />
    <h1 className="ta-onb-title">{t('setup.homeTitle', { name })}</h1>
  </>
  const back = <div className="ta-onb-actions">
    <Button variant="secondary" size="lg" className="rounded-full" disabled={busy} onClick={onBack}>{t('setup.back')}</Button>
  </div>

  if (member === null) return <p className="ta-onb-sub inline-flex items-center gap-2" data-testid="assistant-setup-home-loading">
    <LoadingIndicator size="inline" />{t('cloud.loading')}
  </p>

  return <>
    {header}
    <div className="ta-onb-choices">
      {cloudEnabled ? <div className="ta-onb-choice" data-recommended={cloudAvailable} data-testid="assistant-setup-home-cloud">
        <span className="ta-onb-choice-title">{t('setup.homeCloudTitle')}
          {cloudAvailable ? <span className="ta-onb-choice-recommend">{t('setup.homeRecommended')}</span> : null}
        </span>
        <span className="ta-onb-choice-body">{t('setup.homeCloudBody')}</span>
        <div className="ta-onb-choice-actions">
          {!cloudAvailable ? <>
            <Button variant="secondary" className="rounded-full" disabled={busy || cloudCheck.isPending} onClick={() => cloudCheck.mutate()}>
              {cloudCheck.isPending ? <><LoadingIndicator size="inline" />{t('cloud.loading')}</> : t('setup.retry')}
            </Button>
            {!cloudCheck.error ? <span className="ta-onb-note" role="status">{t(cloudCheck.isSuccess ? 'setup.cloudStillUnavailable' : 'setup.cloudNotOpen')}</span> : null}
          </> : <>
            <Button variant="primary" size="lg" className="rounded-full" disabled={busy} onClick={member ? onCloud : onUpgrade}
              data-testid={member ? 'assistant-setup-claim-cloud' : 'assistant-setup-member'}>
              {t(member ? 'setup.homeCloudAction' : 'setup.homeCloudUpgrade')}
            </Button>
            <span className="ta-onb-note">{t('setup.homeCloudMember')}</span>
          </>}
        </div>
      </div> : null}
      {canHostHere ? <div className="ta-onb-choice" data-testid="assistant-setup-home-server">
        <span className="ta-onb-choice-title">{t('setup.homeServerTitle')}</span>
        <span className="ta-onb-choice-body">{t('setup.homeServerBody')}</span>
        <span className="ta-onb-note">{t('setup.homeServerMethods')}</span>
        <div className="ta-onb-choice-actions">
          <Button variant="secondary" size="lg" className="rounded-full" disabled={busy} onClick={onServer} data-testid="assistant-setup-choose-server">
            {t('setup.homeServerAction')}
          </Button>
        </div>
      </div> : null}
      {canHostHere ? <div className="ta-onb-choice" data-testid="assistant-setup-home-computer">
        <span className="ta-onb-choice-title">{t('setup.homeComputerTitle')}</span>
        <span className="ta-onb-choice-body">{t('setup.homeComputerBody')}</span>
        <div className="ta-onb-choice-actions">
          <Button variant="secondary" size="lg" className="rounded-full" disabled={busy} onClick={onComputer} data-testid="assistant-setup-install-here">
            {t('setup.homeComputerAction')}
          </Button>
        </div>
      </div> : <div className="ta-onb-choice" data-testid="assistant-setup-home-nocomputer">
        <span className="ta-onb-choice-title">{t('setup.homeNoComputerTitle')}</span>
        <span className="ta-onb-choice-body">{t('setup.homeNoComputerBody')}</span>
      </div>}
    </div>
    {cloudCheck.error ? <p className="ta-onb-error" role="alert">{tc(`cloudComputer.reason.${cloudComputerFailureKind(cloudCheck.error)}`)}</p> : null}
    {error ? <p className="ta-onb-error" role="alert" data-testid="assistant-setup-error">{t('setup.failed')}</p> : null}
    {cloudFailure ? <CloudComputerRefusal failure={cloudFailure} prefixKey="devices.cloud.provisionFailed" onUpgrade={onUpgrade} /> : null}
    {back}
  </>
}

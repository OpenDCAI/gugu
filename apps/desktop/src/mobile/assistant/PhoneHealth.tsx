import { Capacitor } from '@capacitor/core'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ArrowUpToLine, FileText, Heart, RefreshCw, Sparkles } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { rendererLogger } from '@/lib/log'
import { HEALTH_REPORT_ACCEPT, HealthBody, isHealthNote } from '@/session/renderer/features/assistant/assistant-health'
import { memoryContentPreview } from '@/session/renderer/features/assistant/memory-content-preview'
import type { MemoryEntry } from '@/session/renderer/features/assistant/assistant-machine-core'
import { AssistantRow, AssistantSection, PageHead, Tile } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { nativePhoneActions } from '../phone-device/nativePhoneActions'
import { readHealthSummary } from '../phone-device/phoneHealth'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneMachineView, ReadFailed, ReadingNow, ReadView } from './PhoneMachineView'
import { healthClock, PHONE_HEALTH_REFRESH_MS, readPhoneHealthView, type PhoneHealthView } from './phoneHealthView'
import { errorText, usePhoneRead, type PhoneRead } from './usePhoneRead'
import './phone-memory.css'

const log = rendererLogger('mobile/assistant')

/** 与桌面健康页、手机的 health.summary 默认同一段:最近 7 天(含今天)。 */
const HEALTH_DAYS = 7

/**
 * 「健康」(记忆首页那张卡点进来,同桌面):数据就在这台手机上,此刻经原生读 Health Connect,
 * ❌ 经云端问自己,也 ❌ 被「它在休息」挡住。读不到分几种如实说并给下一步(去授权 / 重试);
 * 下面「你的健康分析」(让它解读,只填不发;它记进记忆的 health_* 几条,醒着读到了才列)、「分析健康报告」(选文件排进聊天)。
 */
export function PhoneHealth({ assistant, askInChat, go, healthNotes, machine }: PhonePageProps & {
  healthNotes: PhoneRead<{ notes: MemoryEntry[] }> & { reload: () => void }
}) {
  const { t } = useTranslation('assistant')
  const name = assistant.display_name
  const health = usePhoneRead(
    'phone-health',
    () =>
      readPhoneHealthView({
        platform: Capacitor.getPlatform(),
        healthStatus: () => nativePhoneActions.healthStatus(),
        readSummary: (status) => readHealthSummary(HEALTH_DAYS, status),
      }),
    'read phone health',
    (view) => (view.state === 'ok' ? PHONE_HEALTH_REFRESH_MS : null),
  )
  const view = health.state === 'ok' ? health.data : null
  const [granting, setGranting] = useState(false)
  // 弹 Health Connect 自己那一页(人可以只给其中几类);一类都没给 / 系统不再弹,带去 Health Connect 里咕咕那一页(与「这台手机」页同一套)。
  const grant = async () => {
    setGranting(true)
    try {
      const status = await nativePhoneActions.healthRequest()
      if (status.granted_types.length === 0) await nativePhoneActions.openSettings({ target: 'health' })
    } catch (error) {
      log.warn({ error: errorText(error) }, 'health connect permission request failed')
      await nativePhoneActions.openSettings({ target: 'health' }).catch(() => undefined)
    } finally {
      setGranting(false)
      health.reload()
    }
  }
  return (
    <div className="ta-page ta-phone-health" data-testid="assistant-health" data-state={health.state === 'ok' ? health.data.state : health.state}>
      <PageHead
        title={t('health.title')}
        sub={view?.state === 'ok' ? t('health.from', { device: t('health.phone.thisPhone'), time: healthClock(view.summary.generated_at) }) : undefined}
        action={
          <IconButton
            size="lg"
            aria-label={t('health.refresh')}
            disabled={health.state === 'loading'}
            onClick={health.reload}
            data-testid="assistant-health-refresh"
          >
            {health.state === 'loading' ? <LoadingIndicator size="inline" /> : <RefreshCw />}
          </IconButton>
        }
      />
      {health.state === 'loading' ? (
        <ReadingNow label={t('health.loading')} />
      ) : health.state === 'error' ? (
        <div className="ta-card">
          <ReadFailed title={t('health.state.errorTitle')} error={health.error} onRetry={health.reload} />
        </div>
      ) : health.data.state === 'ok' ? (
        <HealthBody summary={health.data.summary} t={t} />
      ) : (
        <ConnectCard view={health.data} granting={granting} onGrant={() => void grant()} onRetry={health.reload} />
      )}
      <AssistantSection
        title={t('health.analysisTitle')}
        action={
          <Button variant="ghost" className="ta-pill-btn" onClick={() => askInChat(t('health.analyzePrompt'))} data-testid="assistant-health-analyze">
            <Sparkles />
            {t('health.analyze', { name })}
          </Button>
        }
        testId="assistant-health-analysis"
      >
        <PhoneMachineView machine={machine} name={name}>
          {() => (
            <ReadView read={healthNotes} failedTitle={t('memory.loadFailed')}>
              {({ notes }) => {
                const analysis = notes.filter((note) => isHealthNote(note.file))
                return analysis.length === 0 ? (
                  <p className="ta-card-text ta-page-sub">{t('health.analysisEmpty', { name })}</p>
                ) : analysis.map((note) => (
                  <AssistantRow
                    key={note.file}
                    leading={<FileText />}
                    title={note.title}
                    detail={memoryContentPreview(note.body, 140)}
                    detailLines={4}
                    onClick={() => go(`note:${note.file}`)}
                    testId={`assistant-health-note-${note.file}`}
                  />
                ))
              }}
            </ReadView>
          )}
        </PhoneMachineView>
      </AssistantSection>
      <ReportUpload askInChat={askInChat} />
    </div>
  )
}

/** 读不到:「让健康状况一目了然」那张卡,下面一句说清是哪一种、去哪弄好。 */
function ConnectCard({ view, granting, onGrant, onRetry }: { view: Exclude<PhoneHealthView, { state: 'ok' }>; granting: boolean; onGrant: () => void; onRetry: () => void }) {
  const { t } = useTranslation('assistant')
  const line = (() => {
    switch (view.state) {
      case 'not-android':
        return t('health.phone.notAndroid')
      case 'old-app':
        return t('health.phone.oldApp')
      case 'unsupported':
        return t('health.phone.unsupported')
      case 'not-granted':
        return t('health.phone.notGranted')
      case 'os-permission':
        return t('health.phone.osPermission')
      case 'failed':
        return t('health.state.failed', { message: view.message })
    }
  })()
  const canGrant = view.state === 'not-granted' || view.state === 'os-permission'
  return (
    <div className="ta-card ta-health-connect" data-testid={`assistant-health-${view.state}`}>
      <span className="ta-tile-icon">
        <Heart />
      </span>
      <h2 className="ta-card-title">{t('health.emptyStateTitle')}</h2>
      <p className="ta-page-sub">{t('health.emptyStateSubtitle')}</p>
      <div className="ta-card-divider" />
      <p className="ta-health-line">{line}</p>
      {canGrant ? (
        <Button variant="ghost" className="ta-pill-btn" disabled={granting} onClick={onGrant} data-testid="assistant-health-grant">
          {t('health.phone.grant')}
        </Button>
      ) : view.state === 'failed' ? (
        <Button variant="ghost" className="ta-pill-btn" onClick={onRetry} data-testid="assistant-health-retry">
          {t('health.retry')}
        </Button>
      ) : null}
    </div>
  )
}

/** 分析健康报告:选一份 PDF / 图片,连同那句话排进和它的聊天(只填不发,人看过再发)。 */
function ReportUpload({ askInChat }: { askInChat: PhonePageProps['askInChat'] }) {
  const { t } = useTranslation('assistant')
  const input = useRef<HTMLInputElement>(null)
  return (
    <AssistantSection title={t('health.addData')} bare testId="assistant-health-add">
      <div className="ta-grid">
        <Tile icon={<ArrowUpToLine />} title={t('health.analyzeReport')} sub={t('health.analyzeReportDescription')} onClick={() => input.current?.click()} testId="assistant-health-report" />
      </div>
      <input
        ref={input}
        type="file"
        accept={HEALTH_REPORT_ACCEPT}
        className="hidden"
        data-testid="assistant-health-report-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          if (files.length > 0) askInChat(t('health.healthReportMessage'), files)
        }}
      />
    </AssistantSection>
  )
}

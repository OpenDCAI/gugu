import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { Collapse } from '@/components/ui/Collapse'
import { formatRelativeTime } from '@/i18n/format'

/**
 * 「机器离线」提示 —— **一行说完，解释收起来**。
 *
 * owner 2026-09-06：「说了一大段废话，能不能折叠一下 / 渐进披露」。原来一屏摆三行：
 * 标题、一整段「时间线要从这台机器上实时读取……」、再加最后在线时间。真正要人知道的只有两件：
 * 它离线了、上次在线是什么时候；「为什么打不开」是**你想知道才去看**的东西。
 *
 * 形制照 orca 的 `HostRouteNoticeBanner`：单行次级文字、单色，❌ 不借用报错的红
 * —— 机器关机不是故障，是常态。
 */
export function OfflineNote({ lastSeenAt }: { lastSeenAt: string | null }) {
  const { t } = useTranslation('main')
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const seen = lastSeenAt ? (formatRelativeTime(lastSeenAt) ?? lastSeenAt) : null

  return (
    <div className="gg-aw-offline">
      <Button
        variant="ghost"
        size="option"
        className="gg-aw-offline-line"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="agent-watch-offline-why"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="gg-aw-offline-text">
          {t('agentWatch.offline.title')}
          {seen ? (
            <>
              <span className="gg-aw-item-sep">·</span>
              {t('agentWatch.offline.lastSeen', { time: seen })}
            </>
          ) : null}
        </span>
        <span className="gg-aw-offline-caret" data-open={open ? 'true' : undefined} aria-hidden="true">
          <ChevronDown />
        </span>
      </Button>
      <Collapse open={open} id={panelId}>
        <div className="gg-aw-offline-body">{t('agentWatch.offline.body')}</div>
      </Collapse>
    </div>
  )
}

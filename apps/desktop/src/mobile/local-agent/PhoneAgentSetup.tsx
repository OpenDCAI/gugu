import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { ChevronLeft } from '@/lib/icons'
import { systemPermissionRows, useSystemPermissionStates } from '@/lib/systemPermissions'
import { PhoneCapabilityGroups } from '../phone-device/PhoneCapabilityGroups'
import { PHONE_ACTION_GROUPS } from '../phone-device/phoneActionCatalog'
import { PhoneAgentHostControl } from './PhoneAgentHostControl'
import { PhoneAgentSetupPermission } from './PhoneAgentSetupPermissions'
import '../phone-device/phone-device.css'

/** One permission form; completion saves presentation state and never grants an unchecked capability. */
export function PhoneAgentSetup({ ownerId, onFinish, onLater, saveError }: {
  ownerId: string
  onFinish: () => void
  onLater: () => void
  saveError: string | null
}) {
  const rows = systemPermissionRows()
  const { states, refresh } = useSystemPermissionStates(rows.map((row) => row.permission))
  const [review, setReview] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0
    heading.current?.focus({ preventScroll: true })
  }, [review])
  const next = () => {
    if (review) onFinish()
    else setReview(true)
  }
  return (
    <form className="gg-phone-setup" data-testid="phone-agent-setup-form" onSubmit={(event) => { event.preventDefault(); next() }}>
      <header className="gg-phone-setup-header">
        <ol className="gg-phone-setup-progress" aria-label="设置步骤">
          <li aria-current={!review ? 'step' : undefined}>1 授权设置</li>
          <li aria-current={review ? 'step' : undefined}>2 确认设置</li>
        </ol>
        <h2 ref={heading} tabIndex={-1} id="phone-agent-setup-heading" className="gg-phone-setup-heading">{review ? '确认手机设置' : '设置这台手机'}</h2>
        <p>{review ? '核对已开启的权限和连接。' : '按需授权，随时可改。'}</p>
        {!review && <div className="gg-phone-setup-summary">{rows.length} 项系统权限 · {PHONE_ACTION_GROUPS.length} 类手机能力</div>}
      </header>
      <div ref={body} className={`gg-phone-setup-body${review ? ' gg-phone-setup-review' : ''}`} data-testid={review ? 'phone-agent-setup-review' : undefined}>
        <section className="gg-phone-setup-section" aria-label="手机运行">
          <h3>手机运行</h3>
          <PhoneAgentHostControl ownerId={ownerId} setup summary={review} />
        </section>
        {rows.length > 0 && <section className="gg-phone-setup-section" aria-label="系统权限">
          <h3>系统权限</h3>
          <div className="gg-phone-setup-fields">
            {rows.map(({ permission }) => <PhoneAgentSetupPermission key={permission} permission={permission} state={states[permission]} onRefresh={refresh} summary={review} />)}
          </div>
        </section>}
        <PhoneCapabilityGroups ownerId={ownerId} context="setup" presentation={review ? 'summary' : 'inline'} />
      </div>
      <div className="gg-phone-setup-footer">
        {saveError && <SettingsNote role="alert" tone="danger">{saveError}</SettingsNote>}
        <div className="gg-phone-setup-navigation">
          <IconButton size="lg" className="gg-phone-setup-back" aria-label={review ? '返回授权设置' : '返回咕咕'} onClick={() => review ? setReview(false) : onLater()}><ChevronLeft /></IconButton>
          <Button variant="primary" type="submit" data-testid={review ? 'phone-agent-setup-finish' : 'phone-agent-setup-next'}>{review ? '完成设置' : '下一步'}</Button>
        </div>
      </div>
    </form>
  )
}

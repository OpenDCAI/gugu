/**
 * 设备改名:「设置 → 设备」那一行与设备详情页(设置、助理 App 共用)同一个输入框、同一条落库路径
 * (useDeviceRename → 设备 store 的 rename → rename_device)。桌面、server、手机的行一视同仁。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'

export function DeviceRenameField({ label, onSave, onCancel }: { label: string; onSave: (next: string) => void; onCancel: () => void }) {
  const { t } = useTranslation('settings')
  const [draft, setDraft] = useState(label)
  return (
    <div className="flex min-w-0 flex-1 items-center gap-[6px]">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave(draft)
          if (e.key === 'Escape') onCancel()
        }}
        aria-label={t('devices.menu.rename')}
        data-testid="device-rename-input"
        // @@@ui-ruler 与同一行的 Button size="sm" 同高:两者都取 --control-h-sm(28)。
        className="box-border min-h-[var(--control-h-sm)] min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--bg)] px-2 text-[length:var(--font-body)] text-[var(--fg)]"
      />
      <Button size="sm" variant="primary" onClick={() => onSave(draft)}>{t('devices.save')}</Button>
      <Button size="sm" onClick={onCancel}>{t('devices.cancel')}</Button>
    </div>
  )
}

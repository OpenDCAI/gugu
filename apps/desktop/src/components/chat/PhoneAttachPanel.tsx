import type { ReactNode } from 'react'
import { Button } from '../ui/Button'
import { useBackLayer } from '../ui/sheetStack'
import './phoneAttach.css'

export type PhoneAttachEntry = { id: string; label: string; icon: ReactNode; disabled?: boolean; onSelect: () => void }

/**
 * 手机输入框的「+」(owner 11-05 认可):在键盘的位置升起一块面板,照片、拍摄、文件分开,后面接这个输入框原有的附加项。
 * 桌面不走这里:照旧是回形针 / 拖拽 / 粘贴。
 */
export function PhoneAttachPanel({ entries, onClose }: { entries: PhoneAttachEntry[]; onClose: () => void }) {
  useBackLayer(onClose)
  return (
    <div className="gg-phone-attach" data-testid="chat-composer-attach-panel">
      {entries.map((entry) => (
        <Button key={entry.id} variant="ghost" className="gg-phone-attach-tile" disabled={entry.disabled} data-testid={`chat-composer-attach-${entry.id}`}
          onClick={() => { onClose(); entry.onSelect() }}>
          <span className="gg-phone-attach-icon" aria-hidden>{entry.icon}</span>
          {entry.label}
        </Button>
      ))}
    </div>
  )
}

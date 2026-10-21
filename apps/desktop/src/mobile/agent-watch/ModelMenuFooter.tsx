import { Button } from '@/components/ui/Button'
import { openBillingPage } from '@/lib/appLinks'
import { openShellSettings } from '@renderer/lib/open-shell-settings'
import { translateSessionMessage } from '@renderer/localization/locale-store'

/**
 * 手机模型清单底下那一段(#7056)—— 与桌面模型面板底部同一组去路:
 *  - 「管理模型」开「我的 › 模型」:哪些出现在这张清单里由那一页的开关定;
 *  - 「升级解锁更多模型」只给这一档有用不了的模型的人(免费档),点了去网页面板。
 * 手机没有悬停,桌面悬浮卡里那句「开会员后能用哪几个」直接写在下面一行。
 * 这一档用不了的模型**不进清单**:列出来点了才说要会员「像是埋雷」(owner 2026-10-10)。
 */
export function ModelMenuFooter({
  lockedModels,
  onLeave,
}: {
  lockedModels: readonly string[]
  /** 去设置之前先把这张面板收起来,❌ 叠在设置页上面。 */
  onLeave: () => void
}) {
  return (
    <div className="gg-aw-choice-section gg-aw-model-footer" data-testid="agent-watch-model-footer">
      <div className="gg-aw-model-footer-actions">
        <Button
          variant="ghost"
          size="sm"
          data-testid="agent-watch-model-manage"
          onClick={() => {
            onLeave()
            openShellSettings('model')
          }}
        >
          {translateSessionMessage('composer.manageModels')}
        </Button>
        {lockedModels.length > 0 && (
          <Button variant="ghost" size="sm" data-testid="agent-watch-model-upgrade" onClick={openBillingPage}>
            {translateSessionMessage('composer.platformModelUpgrade')}
          </Button>
        )}
      </div>
      {lockedModels.length > 0 && (
        <div className="gg-aw-choice-desc gg-aw-choice-note">
          {translateSessionMessage('composer.platformModelUpgradeList', { models: lockedModels.join(' · ') })}
        </div>
      )}
    </div>
  )
}

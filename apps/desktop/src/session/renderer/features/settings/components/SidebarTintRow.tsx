import { setSidebarTintEnabled, useSidebarTintEnabled } from '@/lib/sidebarTint'
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Switch } from '@/components/ui/Switch';
import { SettingsRow } from '@/components/settings/SettingsPrimitives';

/**
 * @@@sidebar-tint 侧栏渐进底色,在设置「界面」最上面。同属外观,但**不是**第四种主题:通过 --sidebar 调整导航底色,
 * 桌面浅色模式相连的工作区外围共用这一档(#7610),正文保持原色。
 * 明暗由设置「通用」里那一组主题按钮决定。默认关(见 lib/sidebarTint.ts)。
 * 2026-09-18 owner:「那个本来应该是放到会话页的设置中的,却放到 app 页设置中了」—— 设置合一之后(product spec)
 * 它仍在会话页画的「界面」这一格里。从前这里还有一张浅色 / 深色 / 跟随系统的卡,与「通用」那组读写同一个值:
 * 一个弹窗里两处改主题,删了这一处。真值仍然只有一份(localStorage + `<html data-sidebar-tint>`,
 * 首帧前由 index.html 的引导脚本落一次),❌ 第二个开关或第二份存储。
 */
export function SidebarTintRow() {
  const sidebarTintEnabled = useSidebarTintEnabled();
  const { translate } = useSessionMessages();
  return (
    <SettingsRow
      title={translate('theme.sidebarTint')}
      description={translate('theme.sidebarTintDescription')}
      control={
        <Switch
          checked={sidebarTintEnabled}
          onCheckedChange={setSidebarTintEnabled}
          aria-label={translate('theme.sidebarTintAria')}
        />
      }
    />
  );
}
